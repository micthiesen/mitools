import Database from "better-sqlite3";
import { Decoder, Encoder } from "cbor";
import { Injector } from "../config/Injector.js";
import { Logger } from "../logging/Logger.js";

const logger = new Logger("Docstore");

// A map is used mostly for tests with different databases
const dbMap = new Map<string, Database.Database>();

function initialize(): Database.Database {
  const db_ = dbMap.get(Injector.config.DB_NAME);
  if (db_) return db_;

  const dbName = Injector.config.DB_NAME;
  const path = Injector.config.DOCKERIZED ? `/data/${dbName}` : dbName;
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.prepare(`
    CREATE TABLE IF NOT EXISTS blobs (
      pk   TEXT PRIMARY KEY,
      data BLOB
    )
  `).run();

  logger.debug("Initialized docstore");
  dbMap.set(dbName, db);
  return db;
}

/**
 * Retrieves the document for a given primary key
 */
export function getDoc<T = unknown>(pk: string): T | undefined {
  const db = initialize();
  const stmt = db.prepare("SELECT data FROM blobs WHERE pk = ?");
  const row = stmt.get(pk) as { data: Buffer } | undefined;
  if (row) {
    const data = Decoder.decodeFirstSync(row.data);
    logger.debug(`Found "${pk}" in docstore`, data);
    return data;
  }

  logger.debug(`"${pk}" not found in docstore`);
}

/**
 * Retrieves all documents matching a given primary key prefix
 */
export function getDocsByPrefix<T = unknown>(prefix: string): T[] {
  const db = initialize();
  const stmt = db.prepare("SELECT data FROM blobs WHERE pk LIKE ?");
  const rows = stmt.all(`${prefix}%`) as { data: Buffer }[];
  return rows.map((row) => Decoder.decodeFirstSync(row.data));
}

/**
 * Upserts a document in the docstore
 */
export function upsertDoc<T = unknown>(pk: string, data: T): void {
  const db = initialize();
  const stmt = db.prepare(`
    INSERT INTO blobs (pk, data)
    VALUES (?, ?)
    ON CONFLICT(pk) DO UPDATE SET data=excluded.data
  `);

  stmt.run(pk, Encoder.encodeOne(data));
  logger.debug(`Upserted "${pk}" in docstore`, data);
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
  const result = db.prepare("DELETE FROM blobs WHERE pk LIKE ?").run(`${prefix}%`);
  logger.debug(`Deleted ${result.changes} docs with prefix "${prefix}"`);
  return result.changes;
}

/**
 * Checks whether a document exists for a given primary key without deserializing.
 */
export function hasDoc(pk: string): boolean {
  const db = initialize();
  const row = db.prepare("SELECT 1 FROM blobs WHERE pk = ?").get(pk);
  return row !== undefined;
}

/**
 * Counts documents matching a given primary key prefix.
 */
export function countByPrefix(prefix: string): number {
  const db = initialize();
  const row = db.prepare("SELECT COUNT(*) as count FROM blobs WHERE pk LIKE ?").get(`${prefix}%`) as { count: number };
  return row.count;
}

/**
 * Returns all primary keys matching a given prefix.
 */
export function getKeysByPrefix(prefix: string): string[] {
  const db = initialize();
  const rows = db.prepare("SELECT pk FROM blobs WHERE pk LIKE ?").all(`${prefix}%`) as { pk: string }[];
  return rows.map((row) => row.pk);
}

/**
 * Escape hatch: returns the raw better-sqlite3 Database instance.
 */
export function getDb(): Database.Database {
  return initialize();
}

/**
 * Clears the docstore
 */
export function clearDocstore(): void {
  const db = initialize();
  db.prepare("DELETE FROM blobs").run();
}
