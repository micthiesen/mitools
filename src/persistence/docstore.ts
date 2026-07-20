import Database from "better-sqlite3";
import { Decoder, Encoder } from "cbor";
import { Injector } from "../config/Injector.js";
import { Logger } from "../logging/Logger.js";

const logger = new Logger("Docstore");

// A map is used mostly for tests with different databases
const dbMap = new Map<string, Database.Database>();

/**
 * Per-row metadata stored alongside the CBOR payload. All fields are optional;
 * omitting a field falls back to the column default (no entity, version 0,
 * never expires, updated_at = now).
 */
export interface DocMeta {
  /** Entity name this row belongs to, or null for raw docstore rows. */
  entity?: string | null;
  /** Schema version of the payload. */
  version?: number;
  /** Absolute expiry (epoch ms), or null to never expire. */
  expiresAt?: number | null;
  /** Last-write timestamp (epoch ms); defaults to now. */
  updatedAt?: number;
}

export interface RawRow {
  pk: string;
  entity: string | null;
  version: number;
  expires_at: number | null;
  updated_at: number;
  data: Buffer;
}

function initialize(): Database.Database {
  const db_ = dbMap.get(Injector.config.DB_NAME);
  if (db_) return db_;

  const dbName = Injector.config.DB_NAME;
  const path = Injector.config.DOCKERIZED ? `/data/${dbName}` : dbName;
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Fresh databases get the full schema; pre-existing ones get additive
  // ALTERs below (cheap, idempotent). Data left by older versions keeps
  // entity = NULL / version = 0 / no expiry until Entity.migrateAll() runs.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS blobs (
      pk         TEXT PRIMARY KEY,
      entity     TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0,
      data       BLOB
    )
  `).run();

  const columns = new Set(
    (db.prepare("PRAGMA table_info(blobs)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  // Tolerate a concurrent process winning the race to ALTER: it may add the
  // column between our PRAGMA read and our ALTER, so ignore "duplicate column".
  const addColumn = (name: string, def: string) => {
    if (columns.has(name)) return;
    try {
      db.exec(`ALTER TABLE blobs ADD COLUMN ${def}`);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  };
  addColumn("entity", "entity TEXT");
  addColumn("version", "version INTEGER NOT NULL DEFAULT 0");
  addColumn("expires_at", "expires_at INTEGER");
  addColumn("updated_at", "updated_at INTEGER NOT NULL DEFAULT 0");

  db.exec("CREATE INDEX IF NOT EXISTS blobs_entity_idx ON blobs(entity)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS blobs_expiry_idx ON blobs(expires_at) WHERE expires_at IS NOT NULL",
  );

  logger.debug("Initialized docstore");
  dbMap.set(dbName, db);
  return db;
}

// An expired row does not exist for any read, whether or not physical cleanup
// has run. This clause is appended to every read query.
const NOT_EXPIRED = "(expires_at IS NULL OR expires_at > @now)";

// Builds a LIKE pattern that matches `prefix` literally: %/_ (and the escape
// char itself) are neutralized, so a prefix containing them can't act as a
// wildcard. Pair with `ESCAPE '\'` in the query.
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// A single unreadable row (truncated/corrupt CBOR) must never abort a
// whole-collection read: one bad blob would otherwise throw out of every
// getAll()/getByPrefix() and take down every consumer of that collection.
// Mirror migrate()'s isolation — warn, skip, and leave the row on disk so it
// stays visible and repairable rather than being silently dropped forever.
const CORRUPT_ROW = Symbol("corrupt-row");

function decodeRow(pk: string, data: Buffer): unknown {
  try {
    return Decoder.decodeFirstSync(data);
  } catch (err) {
    logger.warn(
      `Skipping unreadable docstore row "${pk}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return CORRUPT_ROW;
  }
}

function decodeRows<T>(rows: { pk: string; data: Buffer }[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const data = decodeRow(row.pk, row.data);
    if (data !== CORRUPT_ROW) out.push(data as T);
  }
  return out;
}

// cbor's synchronous encoders (Encoder.encodeOne / cbor.encode) read their
// output stream exactly once, so any payload larger than the stream's
// highWaterMark (~64KB) comes back SILENTLY TRUNCATED — the row then fails to
// decode ("Insufficient data") on the next read and is corrupt on disk. The
// encoder emits its chunks synchronously, so collect every one (no size
// ceiling) instead of relying on that single read. See cbor's own encodeAsync,
// which exists for exactly this reason.
function encodeDoc(data: unknown): Buffer {
  const chunks: Buffer[] = [];
  const encoder = new Encoder();
  encoder.on("data", (chunk: Buffer) => chunks.push(chunk));
  encoder.pushAny(data);
  encoder.end();
  return Buffer.concat(chunks);
}

// Encoding is correct at any size now, but a very large payload is still a smell:
// collection reads (getAll/byPrefix) decode every row in full, so one fat blob
// taxes every list read of its entity. Warn (don't block) so it's noticed before
// it's a performance problem; the fix is usually trimming the row or moving heavy
// fields out, not raising this number.
const LARGE_DOC_WARN_BYTES = 256 * 1024;

/**
 * Retrieves the document for a given primary key. Expired rows read as absent.
 * A point read fails loud on an unreadable (corrupt) row — the caller asked for
 * this exact key, and surfacing the decode error lets a repair tool detect and
 * delete the bad row. Collection reads (getDocsByEntity/getDocsByPrefix) skip
 * corrupt rows instead so one bad blob can't sink the whole batch.
 */
export function getDoc<T = unknown>(pk: string): T | undefined {
  const db = initialize();
  const row = db
    .prepare(`SELECT data FROM blobs WHERE pk = @pk AND ${NOT_EXPIRED}`)
    .get({ pk, now: Date.now() }) as { data: Buffer } | undefined;
  if (row) {
    const data = Decoder.decodeFirstSync(row.data);
    logger.debug(`Found "${pk}" in docstore`, data);
    return data as T;
  }

  logger.debug(`"${pk}" not found in docstore`);
}

/**
 * Retrieves all documents matching a given primary key prefix.
 * Escape-hatch API for raw docstore keys; Entity uses getDocsByEntity.
 * Unreadable rows are skipped (warned) so one corrupt blob can't fail the read.
 */
export function getDocsByPrefix<T = unknown>(prefix: string): T[] {
  const db = initialize();
  const rows = db
    .prepare(
      `SELECT pk, data FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`,
    )
    .all({ like: likePrefix(prefix), now: Date.now() }) as {
    pk: string;
    data: Buffer;
  }[];
  return decodeRows<T>(rows);
}

/**
 * Retrieves all documents belonging to an entity. Expired rows are skipped, as
 * are unreadable (corrupt) rows so one bad blob can't fail the whole read.
 */
export function getDocsByEntity<T = unknown>(entity: string): T[] {
  const db = initialize();
  const rows = db
    .prepare(`SELECT pk, data FROM blobs WHERE entity = @entity AND ${NOT_EXPIRED}`)
    .all({ entity, now: Date.now() }) as { pk: string; data: Buffer }[];
  return decodeRows<T>(rows);
}

/**
 * Upserts a document in the docstore. Metadata defaults to no entity,
 * version 0, no expiry, and updated_at = now.
 */
export function upsertDoc<T = unknown>(pk: string, data: T, meta: DocMeta = {}): void {
  const db = initialize();
  const encoded = encodeDoc(data);
  if (encoded.length > LARGE_DOC_WARN_BYTES) {
    logger.warn(
      `Large docstore payload for "${pk}": ${encoded.length} bytes ` +
        `(> ${LARGE_DOC_WARN_BYTES}). Every collection read of this entity decodes ` +
        `it in full; consider trimming the row or moving heavy fields elsewhere.`,
    );
  }
  db.prepare(`
    INSERT INTO blobs (pk, entity, version, expires_at, updated_at, data)
    VALUES (@pk, @entity, @version, @expires_at, @updated_at, @data)
    ON CONFLICT(pk) DO UPDATE SET
      entity=excluded.entity,
      version=excluded.version,
      expires_at=excluded.expires_at,
      updated_at=excluded.updated_at,
      data=excluded.data
  `).run({
    pk,
    entity: meta.entity ?? null,
    version: meta.version ?? 0,
    expires_at: meta.expiresAt ?? null,
    updated_at: meta.updatedAt ?? Date.now(),
    data: encoded,
  });
  logger.debug(`Upserted "${pk}" in docstore`, data);
}

/**
 * Updates the expiry (and updated_at) of an existing, non-expired row.
 * Returns true if a row was touched.
 */
export function touchDoc(pk: string, expiresAt: number | null): boolean {
  const db = initialize();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE blobs SET expires_at = @expiresAt, updated_at = @now
       WHERE pk = @pk AND ${NOT_EXPIRED}`,
    )
    .run({ pk, expiresAt, now });
  return result.changes > 0;
}

/**
 * Deletes a single document by primary key.
 * Returns true if a document was deleted, false if it didn't exist.
 */
export function deleteDoc(pk: string): boolean {
  const db = initialize();
  const result = db.prepare("DELETE FROM blobs WHERE pk = ?").run(pk);
  const deleted = result.changes > 0;
  logger.debug(`${deleted ? "Deleted" : "No doc found for"} "${pk}" in docstore`);
  return deleted;
}

/**
 * Deletes all documents matching a given primary key prefix.
 * Returns the number of documents deleted.
 */
export function deleteDocsByPrefix(prefix: string): number {
  const db = initialize();
  const result = db
    .prepare("DELETE FROM blobs WHERE pk LIKE ? ESCAPE '\\'")
    .run(likePrefix(prefix));
  logger.debug(`Deleted ${result.changes} docs with prefix "${prefix}"`);
  return result.changes;
}

/**
 * Deletes all documents belonging to an entity.
 * Returns the number of documents deleted.
 */
export function deleteDocsByEntity(entity: string): number {
  const db = initialize();
  const result = db.prepare("DELETE FROM blobs WHERE entity = ?").run(entity);
  logger.debug(`Deleted ${result.changes} docs for entity "${entity}"`);
  return result.changes;
}

/**
 * Checks whether a document exists for a given primary key without
 * deserializing. Expired rows read as absent.
 */
export function hasDoc(pk: string): boolean {
  const db = initialize();
  const row = db
    .prepare(`SELECT 1 FROM blobs WHERE pk = @pk AND ${NOT_EXPIRED}`)
    .get({ pk, now: Date.now() });
  return row !== undefined;
}

/**
 * Counts non-expired documents matching a given primary key prefix.
 */
export function countByPrefix(prefix: string): number {
  const db = initialize();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`,
    )
    .get({ like: likePrefix(prefix), now: Date.now() }) as { count: number };
  return row.count;
}

/**
 * Counts non-expired documents belonging to an entity.
 */
export function countByEntity(entity: string): number {
  const db = initialize();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM blobs WHERE entity = @entity AND ${NOT_EXPIRED}`,
    )
    .get({ entity, now: Date.now() }) as { count: number };
  return row.count;
}

/**
 * Returns all primary keys matching a given prefix (non-expired).
 * Escape-hatch API exposing raw storage keys.
 */
export function getKeysByPrefix(prefix: string): string[] {
  const db = initialize();
  const rows = db
    .prepare(`SELECT pk FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`)
    .all({ like: likePrefix(prefix), now: Date.now() }) as { pk: string }[];
  return rows.map((row) => row.pk);
}

/**
 * Physically deletes up to `limit` expired rows. This is storage maintenance,
 * not expiry correctness (reads already ignore expired rows). Returns the
 * number of rows removed.
 */
export function cleanupExpired(limit = 1000): number {
  const db = initialize();
  const result = db
    .prepare(
      `DELETE FROM blobs WHERE pk IN (
         SELECT pk FROM blobs
         WHERE expires_at IS NOT NULL AND expires_at <= @now
         LIMIT @limit
       )`,
    )
    .run({ now: Date.now(), limit });
  if (result.changes > 0) logger.debug(`Cleaned up ${result.changes} expired docs`);
  return result.changes;
}

/**
 * Returns the raw row (payload + metadata) for a live pk, or undefined if it's
 * missing or expired. Lets callers preserve existing metadata on rewrite.
 */
export function getRawRow(pk: string): RawRow | undefined {
  const db = initialize();
  return db
    .prepare(
      `SELECT pk, entity, version, expires_at, updated_at, data FROM blobs
       WHERE pk = @pk AND ${NOT_EXPIRED}`,
    )
    .get({ pk, now: Date.now() }) as RawRow | undefined;
}

/**
 * Returns raw rows (including expired ones and metadata) matching a prefix.
 * Used by Entity.migrate; not expiry-filtered so migration preserves expiry.
 */
export function getRawRowsByPrefix(prefix: string): RawRow[] {
  const db = initialize();
  return db
    .prepare(
      `SELECT pk, entity, version, expires_at, updated_at, data FROM blobs
       WHERE pk LIKE ? ESCAPE '\\'`,
    )
    .all(likePrefix(prefix)) as RawRow[];
}

/**
 * Runs `fn` inside a single write transaction. Nested reads/writes via the
 * docstore helpers share the same connection and participate in the tx.
 */
export function transaction<T>(fn: () => T): T {
  const db = initialize();
  return db.transaction(fn)();
}

/**
 * Escape hatch: returns the raw better-sqlite3 Database instance.
 */
export function getDb(): Database.Database {
  return initialize();
}

/**
 * Closes the database connection and removes it from the pool.
 */
export function closeDb(): void {
  const dbName = Injector.config.DB_NAME;
  const db = dbMap.get(dbName);
  if (db) {
    db.close();
    dbMap.delete(dbName);
    logger.debug("Closed docstore");
  }
}

/**
 * Clears the docstore
 */
export function clearDocstore(): void {
  const db = initialize();
  db.prepare("DELETE FROM blobs").run();
}
