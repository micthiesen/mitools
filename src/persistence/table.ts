import type Database from "better-sqlite3";
import { Effect } from "effect";
import { type OperationError, operationErrors } from "../errors/index.js";
import { Sqlite } from "./sqlite.js";

const io = operationErrors("table");

export interface ColumnDef {
  type: "TEXT" | "INTEGER" | "REAL" | "BLOB";
  primaryKey?: boolean;
  notNull?: boolean;
}

export interface IndexDef<T> {
  columns: (keyof T)[];
  unique?: boolean;
}

export interface TableOptions<T extends object> {
  name: string;
  columns: Record<keyof T & string, ColumnDef>;
  indexes?: IndexDef<T>[];
}

/**
 * A typed real SQL table (columns, indexes) on the shared `Sqlite` connection.
 * `Table.make` creates the schema idempotently; every operation afterwards is
 * an `Effect` bound to that connection.
 */
export class Table<T extends object> {
  private readonly columnNames: (keyof T & string)[];
  private readonly primaryKeys: (keyof T & string)[];

  private constructor(
    private readonly db: Database.Database,
    private readonly options: TableOptions<T>,
  ) {
    this.columnNames = Object.keys(options.columns) as (keyof T & string)[];
    this.primaryKeys = this.columnNames.filter(
      (col) => options.columns[col].primaryKey,
    );
  }

  /** Ensures the table and its indexes exist, then resolves the typed handle. */
  public static make<T extends object>(
    options: TableOptions<T>,
  ): Effect.Effect<Table<T>, OperationError, Sqlite> {
    return Effect.gen(function* () {
      const { db } = yield* Sqlite;
      const table = new Table<T>(db, options);
      yield* io.sync(`create table ${options.name}`, () => table.createTable());
      yield* io.sync(`create indexes ${options.name}`, () => table.createIndexes());
      yield* Effect.logDebug(`Ensured table ${options.name} and its indexes exist`);
      return table;
    }).pipe(
      Effect.annotateLogs({ logger: `Table:${options.name}` }),
      Effect.withSpan("Table.make"),
    );
  }

  public get name(): string {
    return this.options.name;
  }

  private createTable(): void {
    const colDefs = this.columnNames.map((name) => {
      const col = this.options.columns[name];
      let def = `${name} ${col.type}`;
      if (col.notNull) def += " NOT NULL";
      return def;
    });

    if (this.primaryKeys.length > 0) {
      colDefs.push(`PRIMARY KEY (${this.primaryKeys.join(", ")})`);
    }

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${this.options.name} (${colDefs.join(", ")})`,
      )
      .run();
  }

  private createIndexes(): void {
    for (const index of this.options.indexes ?? []) {
      const cols = index.columns as string[];
      const indexName = `idx_${this.options.name}_${cols.join("_")}`;
      const unique = index.unique ? "UNIQUE " : "";
      this.db
        .prepare(
          `CREATE ${unique}INDEX IF NOT EXISTS ${indexName}` +
            ` ON ${this.options.name} (${cols.join(", ")})`,
        )
        .run();
    }
  }

  /** INSERT OR IGNORE. Resolves true if a row was inserted. */
  public insert(row: T): Effect.Effect<boolean, OperationError> {
    return io
      .sync(`insert into ${this.options.name}`, () => {
        const placeholders = this.columnNames.map(() => "?").join(", ");
        const sql =
          `INSERT OR IGNORE INTO ${this.options.name}` +
          ` (${this.columnNames.join(", ")}) VALUES (${placeholders})`;
        const values = this.columnNames.map((col) => row[col]);
        return this.db.prepare(sql).run(...values).changes > 0;
      })
      .pipe(Effect.withSpan("Table.insert"));
  }

  /** INSERT OR REPLACE. */
  public upsert(row: T): Effect.Effect<void, OperationError> {
    return io
      .sync(`upsert into ${this.options.name}`, () => {
        const placeholders = this.columnNames.map(() => "?").join(", ");
        const sql =
          `INSERT OR REPLACE INTO ${this.options.name}` +
          ` (${this.columnNames.join(", ")}) VALUES (${placeholders})`;
        const values = this.columnNames.map((col) => row[col]);
        this.db.prepare(sql).run(...values);
      })
      .pipe(Effect.withSpan("Table.upsert"));
  }

  /** `SELECT * ... WHERE <where>` with positional params. */
  public query(where: string, params?: unknown[]): Effect.Effect<T[], OperationError> {
    return io
      .sync(
        `query ${this.options.name}`,
        () =>
          this.db
            .prepare(`SELECT * FROM ${this.options.name} WHERE ${where}`)
            .all(...(params ?? [])) as T[],
      )
      .pipe(Effect.withSpan("Table.query"));
  }

  public all(): Effect.Effect<T[], OperationError> {
    return io
      .sync(
        `all ${this.options.name}`,
        () => this.db.prepare(`SELECT * FROM ${this.options.name}`).all() as T[],
      )
      .pipe(Effect.withSpan("Table.all"));
  }

  /** Deletes every row. */
  public clear(): Effect.Effect<void, OperationError> {
    return io
      .sync(`clear ${this.options.name}`, () => {
        this.db.prepare(`DELETE FROM ${this.options.name}`).run();
      })
      .pipe(Effect.withSpan("Table.clear"));
  }
}
