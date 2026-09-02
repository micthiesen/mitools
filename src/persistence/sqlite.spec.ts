import { assert, describe, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { OperationError } from "../errors/index.js";
import { Sqlite } from "./sqlite.js";

const configProvider = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(env));

// `Sqlite.layerConfig` is only observable through the path it opens, so point
// every case at a directory that cannot exist and read the path back out of the
// failure. Keeps the suite from writing a database file anywhere.
const openWithConfig = (env: Record<string, string>) =>
  Sqlite.useSync((s) => s.db).pipe(
    Effect.provide(Sqlite.layerConfig, { local: true }),
    Effect.provide(configProvider(env), { local: true }),
  );

const MISSING_DIR = "mitools-no-such-dir/sqlite.spec.db";

layer(Sqlite.layerMemory)("Sqlite", (it) => {
  it.effect("exposes a usable better-sqlite3 connection", () =>
    Effect.gen(function* () {
      const { db } = yield* Sqlite;
      const row = db.prepare("SELECT 1 + 1 AS n").get() as { n: number };
      assert.strictEqual(row.n, 2);
    }),
  );

  it.effect("commits the statements run inside a transaction", () =>
    Effect.gen(function* () {
      const { db, transaction } = yield* Sqlite;
      db.exec("CREATE TABLE IF NOT EXISTS tx_commit (n INTEGER)");

      const inserted = yield* transaction("insert two", (tx) => {
        tx.prepare("INSERT INTO tx_commit (n) VALUES (1)").run();
        tx.prepare("INSERT INTO tx_commit (n) VALUES (2)").run();
        return "done" as const;
      });

      assert.strictEqual(inserted, "done");
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM tx_commit").get() as {
        count: number;
      };
      assert.strictEqual(count, 2);
    }),
  );

  it.effect("rolls back and fails with OperationError when a transaction throws", () =>
    Effect.gen(function* () {
      const { db, transaction } = yield* Sqlite;
      db.exec("CREATE TABLE IF NOT EXISTS tx_rollback (n INTEGER)");

      const error = yield* Effect.flip(
        transaction("insert then fail", (tx) => {
          tx.prepare("INSERT INTO tx_rollback (n) VALUES (1)").run();
          throw new Error("boom");
        }),
      );

      assert.instanceOf(error, OperationError);
      assert.strictEqual(error._tag, "OperationError");
      assert.strictEqual(error.source, "sqlite");
      assert.strictEqual(error.operation, "insert then fail");
      assert.strictEqual(error.message, "insert then fail: boom");

      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM tx_rollback")
        .get() as { count: number };
      assert.strictEqual(count, 0);
    }),
  );
});

describe("Sqlite layers", () => {
  it.effect("closes the connection when the providing scope closes", () =>
    Effect.gen(function* () {
      const db = yield* Sqlite.useSync((s) => s.db).pipe(
        Effect.provide(Sqlite.layer({ path: ":memory:" }), { local: true }),
      );
      assert.isFalse(db.open);
    }),
  );

  it.effect(
    "fails with a tagged OperationError naming the path it could not open",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Sqlite.useSync((s) => s.db).pipe(
            Effect.provide(Sqlite.layer({ path: MISSING_DIR }), { local: true }),
          ),
        );
        assert.strictEqual(error._tag, "OperationError");
        assert.strictEqual((error as OperationError).source, "sqlite");
        assert.strictEqual((error as OperationError).operation, `open ${MISSING_DIR}`);
      }),
  );

  it.effect("layerConfig reads DB_NAME from the config provider", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(openWithConfig({ DB_NAME: MISSING_DIR }));
      assert.strictEqual(error._tag, "OperationError");
      assert.strictEqual((error as OperationError).operation, `open ${MISSING_DIR}`);
    }),
  );

  it.effect("layerConfig prefixes /data/ when DOCKERIZED", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openWithConfig({ DB_NAME: MISSING_DIR, DOCKERIZED: "true" }),
      );
      assert.strictEqual(error._tag, "OperationError");
      assert.strictEqual(
        (error as OperationError).operation,
        `open /data/${MISSING_DIR}`,
      );
    }),
  );

  it.effect("layerConfig defaults DB_NAME to docstore.db", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(openWithConfig({ DOCKERIZED: "true" }));
      assert.strictEqual(error._tag, "OperationError");
      assert.strictEqual((error as OperationError).operation, "open /data/docstore.db");
    }),
  );

  it.effect("layerConfig fails with a ConfigError on an unparseable DOCKERIZED", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        openWithConfig({ DB_NAME: MISSING_DIR, DOCKERIZED: "maybe" }),
      );
      assert.notStrictEqual(error._tag, "OperationError");
    }),
  );

  it.effect("layerMemory is a fresh in-memory database per build", () =>
    Effect.gen(function* () {
      const memory = Layer.fresh(Sqlite.layerMemory);
      const seen = yield* Sqlite.useSync((s) => {
        s.db.exec("CREATE TABLE marker (n INTEGER)");
        return s.db
          .prepare("SELECT name FROM sqlite_master WHERE name = 'marker'")
          .all().length;
      }).pipe(Effect.provide(memory, { local: true }));
      assert.strictEqual(seen, 1);

      const again = yield* Sqlite.useSync(
        (s) =>
          s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'marker'").all()
            .length,
      ).pipe(Effect.provide(memory, { local: true }));
      assert.strictEqual(again, 0);
    }),
  );
});
