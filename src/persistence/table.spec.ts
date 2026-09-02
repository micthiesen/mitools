import { assert, describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { OperationError } from "../errors/index.js";
import { Sqlite } from "./sqlite.js";
import { Table, type TableOptions } from "./table.js";

type TestItem = {
  id: string;
  name: string;
  value: number;
};

type CompositeItem = {
  group_id: string;
  item_id: string;
  label: string;
};

const itemOptions: TableOptions<TestItem> = {
  name: "test_items",
  columns: {
    id: { type: "TEXT", primaryKey: true },
    name: { type: "TEXT", notNull: true },
    value: { type: "INTEGER" },
  },
  indexes: [{ columns: ["name"] }, { columns: ["value"], unique: true }],
};

const compositeOptions: TableOptions<CompositeItem> = {
  name: "test_composite",
  columns: {
    group_id: { type: "TEXT", primaryKey: true },
    item_id: { type: "TEXT", primaryKey: true },
    label: { type: "TEXT", notNull: true },
  },
};

// `Table.make` is idempotent, so every test can (re)build its own handle over
// the block's shared connection.
const items = Table.make<TestItem>(itemOptions);
const composite = Table.make<CompositeItem>(compositeOptions);

const schemaNames = (table: string) =>
  Sqlite.useSync(({ db }) =>
    (
      db
        .prepare("SELECT name, type FROM sqlite_master WHERE tbl_name = ?")
        .all(table) as { name: string; type: string }[]
    ).map((row) => `${row.type}:${row.name}`),
  );

layer(Sqlite.layerMemory)("Table", (it) => {
  describe("make", () => {
    it.effect("creates the table and its declared indexes", () =>
      Effect.gen(function* () {
        const table = yield* items;
        assert.strictEqual(table.name, "test_items");

        const names = yield* schemaNames("test_items");
        assert.include(names, "table:test_items");
        assert.include(names, "index:idx_test_items_name");
        assert.include(names, "index:idx_test_items_value");
      }),
    );

    it.effect("is idempotent, so a second build reuses the existing schema", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        assert.isTrue(yield* table.insert({ id: "keep", name: "keep", value: -1 }));

        const again = yield* Table.make<TestItem>(itemOptions);
        assert.deepStrictEqual(yield* again.all(), [
          { id: "keep", name: "keep", value: -1 },
        ]);
        yield* again.clear();
      }),
    );
  });

  describe("insert (INSERT OR IGNORE)", () => {
    it.effect("inserts a row and reports that it did", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();

        assert.isTrue(yield* table.insert({ id: "1", name: "alpha", value: 10 }));
        assert.deepStrictEqual(yield* table.all(), [
          { id: "1", name: "alpha", value: 10 },
        ]);
      }),
    );

    it.effect("ignores a duplicate primary key and reports that it did nothing", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        yield* table.insert({ id: "1", name: "alpha", value: 10 });

        assert.isFalse(
          yield* table.insert({ id: "1", name: "updated-alpha", value: 99 }),
        );
        const rows = yield* table.query("id = ?", ["1"]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].name, "alpha"); // original value preserved
      }),
    );

    it.effect("ignores a row that violates a unique index", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        yield* table.insert({ id: "1", name: "alpha", value: 10 });

        // Same `value`, different pk: the unique index on `value` rejects it,
        // and INSERT OR IGNORE turns that into a no-op rather than a failure.
        assert.isFalse(yield* table.insert({ id: "2", name: "beta", value: 10 }));
        assert.strictEqual((yield* table.all()).length, 1);
      }),
    );
  });

  describe("upsert (INSERT OR REPLACE)", () => {
    it.effect("replaces an existing row with the same primary key", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        yield* table.insert({ id: "1", name: "alpha", value: 10 });

        yield* table.upsert({ id: "1", name: "replaced-alpha", value: 42 });
        const rows = yield* table.query("id = ?", ["1"]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].name, "replaced-alpha");
        assert.strictEqual(rows[0].value, 42);
      }),
    );

    it.effect("inserts when the primary key does not exist yet", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();

        yield* table.upsert({ id: "2", name: "beta", value: 20 });
        const rows = yield* table.query("id = ?", ["2"]);
        assert.deepStrictEqual(rows, [{ id: "2", name: "beta", value: 20 }]);
      }),
    );
  });

  describe("reads", () => {
    it.effect("returns the rows matching a parameterized WHERE clause", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        yield* table.insert({ id: "1", name: "alpha", value: 10 });
        yield* table.insert({ id: "2", name: "beta", value: 20 });
        yield* table.insert({ id: "3", name: "gamma", value: 30 });

        const rows = yield* table.query("value > ?", [15]);
        assert.deepStrictEqual(rows.map((row) => row.id).toSorted(), ["2", "3"]);
      }),
    );

    it.effect("returns every row from all() and none after clear()", () =>
      Effect.gen(function* () {
        const table = yield* items;
        yield* table.clear();
        yield* table.insert({ id: "1", name: "alpha", value: 10 });
        yield* table.insert({ id: "2", name: "beta", value: 20 });

        assert.deepStrictEqual((yield* table.all()).map((row) => row.id).toSorted(), [
          "1",
          "2",
        ]);

        yield* table.clear();
        assert.deepStrictEqual(yield* table.all(), []);
      }),
    );

    it.effect("fails with a tagged OperationError on an invalid WHERE clause", () =>
      Effect.gen(function* () {
        const table = yield* items;
        const error = yield* Effect.flip(table.query("no_such_column = ?", ["x"]));
        assert.strictEqual(error._tag, "OperationError");
        assert.strictEqual((error as OperationError).source, "table");
        assert.strictEqual((error as OperationError).operation, "query test_items");
        assert.match(error.message, /^query test_items: /);
      }),
    );
  });

  describe("composite primary keys", () => {
    it.effect("treats the full tuple as the key for insert and upsert", () =>
      Effect.gen(function* () {
        const table = yield* composite;
        yield* table.clear();

        yield* table.insert({ group_id: "g1", item_id: "i1", label: "first" });
        yield* table.insert({ group_id: "g1", item_id: "i2", label: "second" });
        yield* table.insert({ group_id: "g2", item_id: "i1", label: "third" });
        assert.strictEqual((yield* table.all()).length, 3);

        // Same composite key: ignored.
        assert.isFalse(
          yield* table.insert({ group_id: "g1", item_id: "i1", label: "duplicate" }),
        );
        assert.strictEqual((yield* table.all()).length, 3);
        const row = yield* table.query("group_id = ? AND item_id = ?", ["g1", "i1"]);
        assert.strictEqual(row[0].label, "first");

        // Upsert replaces it.
        yield* table.upsert({ group_id: "g1", item_id: "i1", label: "replaced" });
        const updated = yield* table.query("group_id = ? AND item_id = ?", [
          "g1",
          "i1",
        ]);
        assert.strictEqual(updated[0].label, "replaced");
      }),
    );

    it.effect("queries by a single column of the composite key", () =>
      Effect.gen(function* () {
        const table = yield* composite;
        yield* table.clear();
        yield* table.insert({ group_id: "g1", item_id: "i1", label: "first" });
        yield* table.insert({ group_id: "g1", item_id: "i2", label: "second" });
        yield* table.insert({ group_id: "g2", item_id: "i1", label: "third" });

        assert.strictEqual((yield* table.query("group_id = ?", ["g1"])).length, 2);
      }),
    );
  });

  describe("column definitions", () => {
    it.effect("applies NOT NULL and the declared column types", () =>
      Effect.gen(function* () {
        const table = yield* Table.make<{ id: string; blob: Uint8Array }>({
          name: "test_columns",
          columns: {
            id: { type: "TEXT", primaryKey: true },
            blob: { type: "BLOB", notNull: true },
          },
        });
        const payload = Buffer.from([1, 2, 3]);
        assert.isTrue(yield* table.insert({ id: "b", blob: payload }));
        expect((yield* table.all())[0].blob).toEqual(payload);

        const columns = yield* Sqlite.useSync(
          ({ db }) =>
            db.prepare("PRAGMA table_info(test_columns)").all() as {
              name: string;
              type: string;
              notnull: number;
            }[],
        );
        const blob = columns.find((column) => column.name === "blob");
        assert.strictEqual(blob?.type, "BLOB");
        assert.strictEqual(blob?.notnull, 1);
      }),
    );

    it.effect("creates a table without a primary key when none is declared", () =>
      Effect.gen(function* () {
        const table = yield* Table.make<{ n: number }>({
          name: "test_keyless",
          columns: { n: { type: "INTEGER" } },
        });
        assert.isTrue(yield* table.insert({ n: 1 }));
        assert.isTrue(yield* table.insert({ n: 1 }));
        assert.strictEqual((yield* table.all()).length, 2);
      }),
    );
  });
});
