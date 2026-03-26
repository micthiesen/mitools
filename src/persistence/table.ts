import { Logger } from "../logging/Logger.js";
import { getDb } from "./docstore.js";

const logger = new Logger("Table");

export interface ColumnDef {
  type: "TEXT" | "INTEGER" | "REAL" | "BLOB";
  primaryKey?: boolean;
  notNull?: boolean;
}

export interface IndexDef<T> {
  columns: (keyof T)[];
  unique?: boolean;
}

export interface TableOptions<T> {
  name: string;
  columns: Record<keyof T, ColumnDef>;
  indexes?: IndexDef<T>[];
}

export class Table<T extends Record<string, unknown>> {
  private readonly log: Logger;
  private readonly columnNames: (keyof T & string)[];
  private readonly primaryKeys: (keyof T & string)[];

  constructor(private readonly options: TableOptions<T>) {
    this.log = logger.extend(options.name);
    this.columnNames = Object.keys(options.columns) as (keyof T & string)[];
    this.primaryKeys = this.columnNames.filter(
      (col) => options.columns[col].primaryKey,
    );

    this.createTable();
    this.createIndexes();
  }

  private createTable(): void {
    const db = getDb();
    const colDefs = this.columnNames.map((name) => {
      const col = this.options.columns[name];
      let def = `${name} ${col.type}`;
      if (col.notNull) def += " NOT NULL";
      return def;
    });

    if (this.primaryKeys.length > 0) {
      colDefs.push(`PRIMARY KEY (${this.primaryKeys.join(", ")})`);
    }

    const sql = `CREATE TABLE IF NOT EXISTS ${this.options.name} (${colDefs.join(", ")})`;
    db.prepare(sql).run();
    this.log.debug("Ensured table exists");
  }

  private createIndexes(): void {
    const db = getDb();
    for (const index of this.options.indexes ?? []) {
      const cols = index.columns as string[];
      const indexName = `idx_${this.options.name}_${cols.join("_")}`;
      const unique = index.unique ? "UNIQUE " : "";
      const sql =
        `CREATE ${unique}INDEX IF NOT EXISTS ${indexName}` +
        ` ON ${this.options.name} (${cols.join(", ")})`;
      db.prepare(sql).run();
      this.log.debug(`Ensured index ${indexName}`);
    }
  }

  insert(row: T): void {
    const db = getDb();
    const placeholders = this.columnNames.map(() => "?").join(", ");
    const sql =
      `INSERT OR IGNORE INTO ${this.options.name}` +
      ` (${this.columnNames.join(", ")}) VALUES (${placeholders})`;
    const values = this.columnNames.map((col) => row[col]);
    db.prepare(sql).run(...values);
    this.log.debug("Insert (or ignore)", row);
  }

  upsert(row: T): void {
    const db = getDb();
    const placeholders = this.columnNames.map(() => "?").join(", ");
    const sql =
      `INSERT OR REPLACE INTO ${this.options.name}` +
      ` (${this.columnNames.join(", ")}) VALUES (${placeholders})`;
    const values = this.columnNames.map((col) => row[col]);
    db.prepare(sql).run(...values);
    this.log.debug("Upsert", row);
  }

  query(where: string, params?: unknown[]): T[] {
    const db = getDb();
    const sql = `SELECT * FROM ${this.options.name} WHERE ${where}`;
    const rows = db.prepare(sql).all(...(params ?? [])) as T[];
    this.log.debug(`Query returned ${rows.length} rows`, { where, params });
    return rows;
  }

  all(): T[] {
    const db = getDb();
    const sql = `SELECT * FROM ${this.options.name}`;
    const rows = db.prepare(sql).all() as T[];
    this.log.debug(`All returned ${rows.length} rows`);
    return rows;
  }

  clear(): void {
    const db = getDb();
    db.prepare(`DELETE FROM ${this.options.name}`).run();
    this.log.debug("Cleared all rows");
  }
}
