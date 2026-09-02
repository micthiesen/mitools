import Database from "better-sqlite3";
import { Config, Context, Effect, Layer } from "effect";
import { type OperationError, operationErrors } from "../errors/index.js";

const io = operationErrors("sqlite");

export interface SqliteOptions {
  /** File path of the database, or ":memory:" for an in-process database. */
  readonly path: string;
}

/**
 * One better-sqlite3 connection (WAL mode). The docstore, `Entity` and `Table`
 * all share it. Build it once per process with `Sqlite.layer(...)` and let the
 * layer's scope close the connection.
 */
export class Sqlite extends Context.Service<
  Sqlite,
  {
    readonly db: Database.Database;
    /** Runs `fn` inside one write transaction; nested statements share the connection. */
    readonly transaction: <A>(
      operation: string,
      fn: (db: Database.Database) => A,
    ) => Effect.Effect<A, OperationError>;
  }
>()("@micthiesen/mitools/Sqlite") {
  /** Opens the database at `path`; closed when the layer's scope closes. */
  static readonly layer = (
    options: SqliteOptions,
  ): Layer.Layer<Sqlite, OperationError> =>
    Layer.effect(
      Sqlite,
      Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          io.sync(`open ${options.path}`, () => {
            const db = new Database(options.path);
            db.pragma("journal_mode = WAL");
            db.pragma("synchronous = NORMAL");
            return db;
          }),
          (db) =>
            io
              .sync(`close ${options.path}`, () => db.close())
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Closing sqlite failed", cause),
                ),
              ),
        );
        yield* Effect.logDebug(`Opened sqlite database ${options.path}`);
        return Sqlite.of({
          db,
          transaction: (operation, fn) =>
            io.sync(operation, () => db.transaction(() => fn(db))()),
        });
      }).pipe(Effect.annotateLogs({ logger: "Sqlite" })),
    );

  /**
   * Reads `DB_NAME` (default `docstore.db`) and `DOCKERIZED` (default false)
   * from the configured `ConfigProvider`; a dockerized process stores the
   * file under `/data/`.
   */
  static readonly layerConfig: Layer.Layer<
    Sqlite,
    OperationError | Config.ConfigError
  > = Layer.unwrap(
    Effect.gen(function* () {
      const { dbName, dockerized } = yield* Config.all({
        dbName: Config.string("DB_NAME").pipe(Config.withDefault("docstore.db")),
        dockerized: Config.boolean("DOCKERIZED").pipe(Config.withDefault(false)),
      });
      return Sqlite.layer({ path: dockerized ? `/data/${dbName}` : dbName });
    }),
  );

  /** An in-memory database, for tests. */
  static readonly layerMemory: Layer.Layer<Sqlite, OperationError> = Sqlite.layer({
    path: ":memory:",
  });
}
