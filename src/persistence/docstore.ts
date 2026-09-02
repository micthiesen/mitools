import type Database from "better-sqlite3";
import { Decoder, Encoder } from "cbor";
import { Clock, Context, Data, Effect, Layer, Option } from "effect";
import { causeMessage, OperationError, operationErrors } from "../errors/index.js";
import { Sqlite } from "./sqlite.js";

const io = operationErrors("docstore");
const annotate = Effect.annotateLogs({ logger: "Docstore" });

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

/**
 * A point read hit a row whose CBOR payload cannot be decoded. The caller asked
 * for this exact key, so the failure is surfaced (rather than read as absent)
 * to let a repair tool detect and delete the bad row.
 */
export class CorruptRowError extends Data.TaggedError("CorruptRowError")<{
  readonly pk: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `unreadable docstore row "${this.pk}": ${causeMessage(this.cause)}`;
  }
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

// cbor's synchronous encoders (Encoder.encodeOne / cbor.encode) read their
// output stream exactly once, so any payload larger than the stream's
// highWaterMark (~64KB) comes back SILENTLY TRUNCATED. The encoder emits its
// chunks synchronously, so collect every one (no size ceiling) instead of
// relying on that single read. See cbor's own encodeAsync.
export function encodeDoc(data: unknown): Buffer {
  const chunks: Buffer[] = [];
  const encoder = new Encoder();
  encoder.on("data", (chunk: Buffer) => chunks.push(chunk));
  encoder.pushAny(data);
  encoder.end();
  return Buffer.concat(chunks);
}

/** Decodes one stored payload; throws on corrupt CBOR. */
export function decodeDoc<T = unknown>(data: Buffer): T {
  return Decoder.decodeFirstSync(data) as T;
}

// Encoding is correct at any size, but a very large payload is still a smell:
// collection reads decode every row in full, so one fat blob taxes every list
// read of its entity. Warn (don't block) so it's noticed before it's a
// performance problem.
const LARGE_DOC_WARN_BYTES = 256 * 1024;

/**
 * Synchronous statements over the shared connection. Every function may throw
 * (better-sqlite3 / cbor); the `Docstore` service wraps them once as
 * `OperationError`. Exposed so `Entity` can compose several steps inside a
 * single transaction.
 */
export interface DocstoreSync {
  readonly getRawRow: (pk: string, now: number) => RawRow | undefined;
  readonly upsertDoc: (pk: string, data: unknown, meta: DocMeta, now: number) => number;
  readonly deleteDoc: (pk: string) => boolean;
  readonly getRawRowsByPrefix: (prefix: string) => RawRow[];
}

function makeSync(db: Database.Database): DocstoreSync {
  return {
    getRawRow: (pk, now) =>
      db
        .prepare(
          `SELECT pk, entity, version, expires_at, updated_at, data FROM blobs
           WHERE pk = @pk AND ${NOT_EXPIRED}`,
        )
        .get({ pk, now }) as RawRow | undefined,
    upsertDoc: (pk, data, meta, now) => {
      const encoded = encodeDoc(data);
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
        updated_at: meta.updatedAt ?? now,
        data: encoded,
      });
      return encoded.length;
    },
    deleteDoc: (pk) => db.prepare("DELETE FROM blobs WHERE pk = ?").run(pk).changes > 0,
    getRawRowsByPrefix: (prefix) =>
      db
        .prepare(
          `SELECT pk, entity, version, expires_at, updated_at, data FROM blobs
           WHERE pk LIKE ? ESCAPE '\\'`,
        )
        .all(likePrefix(prefix)) as RawRow[],
  };
}

function initializeSchema(db: Database.Database): void {
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
}

export interface DocstoreShape {
  /**
   * Retrieves the document for a primary key. Expired rows read as absent. A
   * point read fails with `CorruptRowError` on an unreadable row; collection
   * reads skip such rows instead so one bad blob can't sink the whole batch.
   */
  getDoc<T = unknown>(
    pk: string,
  ): Effect.Effect<Option.Option<T>, OperationError | CorruptRowError>;
  /** Raw-key escape hatch; `Entity` uses `getDocsByEntity`. Unreadable rows are skipped (warned). */
  getDocsByPrefix<T = unknown>(prefix: string): Effect.Effect<T[], OperationError>;
  /** All live documents of an entity. Unreadable rows are skipped (warned). */
  getDocsByEntity<T = unknown>(entity: string): Effect.Effect<T[], OperationError>;
  /** Upserts a document. Metadata defaults: no entity, version 0, no expiry, updated_at = now. */
  upsertDoc<T = unknown>(
    pk: string,
    data: T,
    meta?: DocMeta,
  ): Effect.Effect<void, OperationError>;
  /** Updates the expiry (and updated_at) of a live row. Resolves true if a row was touched. */
  touchDoc(
    pk: string,
    expiresAt: number | null,
  ): Effect.Effect<boolean, OperationError>;
  /** Resolves true if a document was deleted. */
  deleteDoc(pk: string): Effect.Effect<boolean, OperationError>;
  /** Resolves the number of documents deleted. */
  deleteDocsByPrefix(prefix: string): Effect.Effect<number, OperationError>;
  /** Resolves the number of documents deleted. */
  deleteDocsByEntity(entity: string): Effect.Effect<number, OperationError>;
  /** Existence check without deserializing. Expired rows read as absent. */
  hasDoc(pk: string): Effect.Effect<boolean, OperationError>;
  countByPrefix(prefix: string): Effect.Effect<number, OperationError>;
  countByEntity(entity: string): Effect.Effect<number, OperationError>;
  /** All live primary keys matching a prefix (raw storage keys). */
  getKeysByPrefix(prefix: string): Effect.Effect<string[], OperationError>;
  /**
   * Physically deletes up to `limit` expired rows. Storage maintenance, not
   * expiry correctness (reads already ignore expired rows).
   */
  cleanupExpired(limit?: number): Effect.Effect<number, OperationError>;
  /** The raw row (payload + metadata) for a live pk. */
  getRawRow(pk: string): Effect.Effect<Option.Option<RawRow>, OperationError>;
  /** Raw rows (including expired ones) matching a prefix. Used by `Entity.migrate`. */
  getRawRowsByPrefix(prefix: string): Effect.Effect<RawRow[], OperationError>;
  /**
   * Runs synchronous statements inside one write transaction. `fn` must not
   * return an Effect: it would never run.
   */
  transaction<A>(
    operation: string,
    fn: (tx: DocstoreSync) => A,
  ): Effect.Effect<A, OperationError>;
  /** Deletes every row. */
  readonly clear: Effect.Effect<void, OperationError>;
}

/**
 * CBOR-encoded documents in a single `blobs` table of the shared `Sqlite`
 * connection, keyed by primary key with entity/version/expiry metadata columns.
 */
export class Docstore extends Context.Service<Docstore, DocstoreShape>()(
  "@micthiesen/mitools/Docstore",
) {
  /** Ensures the `blobs` schema on the shared connection and exposes the store. */
  static readonly layer: Layer.Layer<Docstore, OperationError, Sqlite> = Layer.effect(
    Docstore,
    Effect.gen(function* () {
      const { db, transaction } = yield* Sqlite;
      yield* io.sync("initialize schema", () => initializeSchema(db));
      yield* Effect.logDebug("Initialized docstore");
      return Docstore.of(makeDocstore(db, transaction));
    }).pipe(annotate),
  );

  /** Docstore over an in-memory database, for tests. Exposes `Sqlite` too. */
  static readonly layerMemory: Layer.Layer<Docstore | Sqlite, OperationError> =
    Docstore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
}

function makeDocstore(
  db: Database.Database,
  transaction: Sqlite["Service"]["transaction"],
): DocstoreShape {
  const sync = makeSync(db);
  const now = Clock.currentTimeMillis;

  // A single unreadable row (truncated/corrupt CBOR) must never abort a
  // whole-collection read: one bad blob would otherwise take down every
  // consumer of that collection. Warn, skip, and leave the row on disk so it
  // stays visible and repairable rather than being silently dropped forever.
  const decodeRows = Effect.fnUntraced(function* <T>(
    rows: { pk: string; data: Buffer }[],
  ) {
    const out: T[] = [];
    for (const row of rows) {
      const decoded = yield* Effect.try({
        try: () => decodeDoc<T>(row.data),
        catch: (cause) => new CorruptRowError({ pk: row.pk, cause }),
      }).pipe(
        Effect.tapError((error) => Effect.logWarning(`Skipping ${error.message}`)),
        Effect.option,
      );
      if (Option.isSome(decoded)) out.push(decoded.value);
    }
    return out;
  });

  const getDoc = Effect.fn("Docstore.getDoc")(function* <T>(pk: string) {
    const t = yield* now;
    const row = yield* io.sync(
      `getDoc ${pk}`,
      () =>
        db.prepare(`SELECT data FROM blobs WHERE pk = @pk AND ${NOT_EXPIRED}`).get({
          pk,
          now: t,
        }) as { data: Buffer } | undefined,
    );
    if (!row) return Option.none<T>();
    const data = yield* Effect.try({
      try: () => decodeDoc<T>(row.data),
      catch: (cause) => new CorruptRowError({ pk, cause }),
    });
    return Option.some(data);
  }, annotate);

  const getDocsByPrefix = Effect.fn("Docstore.getDocsByPrefix")(function* <T>(
    prefix: string,
  ) {
    const t = yield* now;
    const rows = yield* io.sync(
      `getDocsByPrefix ${prefix}`,
      () =>
        db
          .prepare(
            `SELECT pk, data FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`,
          )
          .all({ like: likePrefix(prefix), now: t }) as { pk: string; data: Buffer }[],
    );
    return yield* decodeRows<T>(rows);
  }, annotate);

  const getDocsByEntity = Effect.fn("Docstore.getDocsByEntity")(function* <T>(
    entity: string,
  ) {
    const t = yield* now;
    const rows = yield* io.sync(
      `getDocsByEntity ${entity}`,
      () =>
        db
          .prepare(
            `SELECT pk, data FROM blobs WHERE entity = @entity AND ${NOT_EXPIRED}`,
          )
          .all({ entity, now: t }) as { pk: string; data: Buffer }[],
    );
    return yield* decodeRows<T>(rows);
  }, annotate);

  const upsertDoc = Effect.fn("Docstore.upsertDoc")(function* <T>(
    pk: string,
    data: T,
    meta: DocMeta = {},
  ) {
    const t = yield* now;
    const bytes = yield* io.sync(`upsertDoc ${pk}`, () =>
      sync.upsertDoc(pk, data, meta, t),
    );
    if (bytes > LARGE_DOC_WARN_BYTES) {
      yield* Effect.logWarning(
        `Large docstore payload for "${pk}": ${bytes} bytes ` +
          `(> ${LARGE_DOC_WARN_BYTES}). Every collection read of this entity decodes ` +
          `it in full; consider trimming the row or moving heavy fields elsewhere.`,
      );
    }
    yield* Effect.logDebug(`Upserted "${pk}" in docstore`);
  }, annotate);

  const touchDoc = Effect.fn("Docstore.touchDoc")(function* (
    pk: string,
    expiresAt: number | null,
  ) {
    const t = yield* now;
    const changes = yield* io.sync(
      `touchDoc ${pk}`,
      () =>
        db
          .prepare(
            `UPDATE blobs SET expires_at = @expiresAt, updated_at = @now
             WHERE pk = @pk AND ${NOT_EXPIRED}`,
          )
          .run({ pk, expiresAt, now: t }).changes,
    );
    return changes > 0;
  }, annotate);

  const deleteDoc = Effect.fn("Docstore.deleteDoc")(function* (pk: string) {
    const deleted = yield* io.sync(`deleteDoc ${pk}`, () => sync.deleteDoc(pk));
    yield* Effect.logDebug(
      `${deleted ? "Deleted" : "No doc found for"} "${pk}" in docstore`,
    );
    return deleted;
  }, annotate);

  const deleteDocsByPrefix = Effect.fn("Docstore.deleteDocsByPrefix")(function* (
    prefix: string,
  ) {
    const changes = yield* io.sync(
      `deleteDocsByPrefix ${prefix}`,
      () =>
        db
          .prepare("DELETE FROM blobs WHERE pk LIKE ? ESCAPE '\\'")
          .run(likePrefix(prefix)).changes,
    );
    yield* Effect.logDebug(`Deleted ${changes} docs with prefix "${prefix}"`);
    return changes;
  }, annotate);

  const deleteDocsByEntity = Effect.fn("Docstore.deleteDocsByEntity")(function* (
    entity: string,
  ) {
    const changes = yield* io.sync(
      `deleteDocsByEntity ${entity}`,
      () => db.prepare("DELETE FROM blobs WHERE entity = ?").run(entity).changes,
    );
    yield* Effect.logDebug(`Deleted ${changes} docs for entity "${entity}"`);
    return changes;
  }, annotate);

  const hasDoc = Effect.fn("Docstore.hasDoc")(function* (pk: string) {
    const t = yield* now;
    const row = yield* io.sync(`hasDoc ${pk}`, () =>
      db
        .prepare(`SELECT 1 FROM blobs WHERE pk = @pk AND ${NOT_EXPIRED}`)
        .get({ pk, now: t }),
    );
    return row !== undefined;
  }, annotate);

  const countByPrefix = Effect.fn("Docstore.countByPrefix")(function* (prefix: string) {
    const t = yield* now;
    const row = yield* io.sync(
      `countByPrefix ${prefix}`,
      () =>
        db
          .prepare(
            `SELECT COUNT(*) as count FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`,
          )
          .get({ like: likePrefix(prefix), now: t }) as { count: number },
    );
    return row.count;
  }, annotate);

  const countByEntity = Effect.fn("Docstore.countByEntity")(function* (entity: string) {
    const t = yield* now;
    const row = yield* io.sync(
      `countByEntity ${entity}`,
      () =>
        db
          .prepare(
            `SELECT COUNT(*) as count FROM blobs WHERE entity = @entity AND ${NOT_EXPIRED}`,
          )
          .get({ entity, now: t }) as { count: number },
    );
    return row.count;
  }, annotate);

  const getKeysByPrefix = Effect.fn("Docstore.getKeysByPrefix")(function* (
    prefix: string,
  ) {
    const t = yield* now;
    const rows = yield* io.sync(
      `getKeysByPrefix ${prefix}`,
      () =>
        db
          .prepare(
            `SELECT pk FROM blobs WHERE pk LIKE @like ESCAPE '\\' AND ${NOT_EXPIRED}`,
          )
          .all({ like: likePrefix(prefix), now: t }) as { pk: string }[],
    );
    return rows.map((row) => row.pk);
  }, annotate);

  const cleanupExpired = Effect.fn("Docstore.cleanupExpired")(function* (limit = 1000) {
    const t = yield* now;
    const changes = yield* io.sync(
      "cleanupExpired",
      () =>
        db
          .prepare(
            `DELETE FROM blobs WHERE pk IN (
               SELECT pk FROM blobs
               WHERE expires_at IS NOT NULL AND expires_at <= @now
               LIMIT @limit
             )`,
          )
          .run({ now: t, limit }).changes,
    );
    if (changes > 0) yield* Effect.logDebug(`Cleaned up ${changes} expired docs`);
    return changes;
  }, annotate);

  const getRawRow = Effect.fn("Docstore.getRawRow")(function* (pk: string) {
    const t = yield* now;
    const row = yield* io.sync(`getRawRow ${pk}`, () => sync.getRawRow(pk, t));
    return Option.fromNullishOr(row);
  }, annotate);

  const getRawRowsByPrefix = Effect.fn("Docstore.getRawRowsByPrefix")(
    (prefix: string) =>
      io.sync(`getRawRowsByPrefix ${prefix}`, () => sync.getRawRowsByPrefix(prefix)),
    annotate,
  );

  const clear = io.sync("clear", () => {
    db.prepare("DELETE FROM blobs").run();
  });

  return {
    getDoc,
    getDocsByPrefix,
    getDocsByEntity,
    upsertDoc,
    touchDoc,
    deleteDoc,
    deleteDocsByPrefix,
    deleteDocsByEntity,
    hasDoc,
    countByPrefix,
    countByEntity,
    getKeysByPrefix,
    cleanupExpired,
    getRawRow,
    getRawRowsByPrefix,
    transaction: (operation, fn) =>
      transaction(operation, () => fn(sync)).pipe(
        Effect.mapError(
          (error) => new OperationError({ ...error, source: "docstore" }),
        ),
      ),
    clear,
  };
}

// Accessors: the same operations as effects that require the `Docstore`
// service, for callers that would rather not yield the service first.

export const getDoc = <T = unknown>(pk: string) => Docstore.use((s) => s.getDoc<T>(pk));
export const getDocsByPrefix = <T = unknown>(prefix: string) =>
  Docstore.use((s) => s.getDocsByPrefix<T>(prefix));
export const getDocsByEntity = <T = unknown>(entity: string) =>
  Docstore.use((s) => s.getDocsByEntity<T>(entity));
export const upsertDoc = <T = unknown>(pk: string, data: T, meta?: DocMeta) =>
  Docstore.use((s) => s.upsertDoc(pk, data, meta));
export const touchDoc = (pk: string, expiresAt: number | null) =>
  Docstore.use((s) => s.touchDoc(pk, expiresAt));
export const deleteDoc = (pk: string) => Docstore.use((s) => s.deleteDoc(pk));
export const deleteDocsByPrefix = (prefix: string) =>
  Docstore.use((s) => s.deleteDocsByPrefix(prefix));
export const deleteDocsByEntity = (entity: string) =>
  Docstore.use((s) => s.deleteDocsByEntity(entity));
export const hasDoc = (pk: string) => Docstore.use((s) => s.hasDoc(pk));
export const countByPrefix = (prefix: string) =>
  Docstore.use((s) => s.countByPrefix(prefix));
export const countByEntity = (entity: string) =>
  Docstore.use((s) => s.countByEntity(entity));
export const getKeysByPrefix = (prefix: string) =>
  Docstore.use((s) => s.getKeysByPrefix(prefix));
export const cleanupExpired = (limit?: number) =>
  Docstore.use((s) => s.cleanupExpired(limit));
export const getRawRow = (pk: string) => Docstore.use((s) => s.getRawRow(pk));
export const getRawRowsByPrefix = (prefix: string) =>
  Docstore.use((s) => s.getRawRowsByPrefix(prefix));
export const clearDocstore = Docstore.use((s) => s.clear);
