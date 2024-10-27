import Database from "better-sqlite3";
import { decode, encode } from "cbor";
import { Logger } from "../logging/Logger.js";

const logger = new Logger("docstore");

let db_: Database.Database | undefined;

function initialize(): Database.Database {
  if (db_) return db_;

  db_ = new Database("docstore.db");

  db_.pragma("journal_mode = WAL");
  db_.pragma("synchronous = NORMAL");

  db_
    .prepare(`
    CREATE TABLE IF NOT EXISTS blobs (
      pk   TEXT PRIMARY KEY,
      data BLOB
    )
  `)
    .run();

  logger.debug("Initialized docstore");
  return db_;
}

/**
 * Retrieves the document for a given primary key
 */
export function getDoc<T = unknown>(pk: string): T | undefined {
  const db = initialize();
  const stmt = db.prepare("SELECT data FROM blobs WHERE pk = ?");
  const row = stmt.get(pk) as { data: Buffer } | undefined;
  if (row) {
    const data = decode(row.data);
    logger.debug(`Found "${pk}" in docstore`, data);
    return data;
  }

  logger.debug(`"${pk}" not found in docstore`);
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

  stmt.run(pk, encode(data));
  logger.debug(`Upserted "${pk}" in docstore`, data);
}
