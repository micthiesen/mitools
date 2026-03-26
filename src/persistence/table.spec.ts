import { beforeAll, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import { getDb } from "./docstore.js";
import { Table } from "./table.js";

Injector.configure({
  config: {
    LOG_LEVEL: LogLevel.DEBUG,
    PUSHOVER_TOKEN: "fake-token",
    PUSHOVER_USER: "fake-user",
    DOCKERIZED: false,
    DB_NAME: "table.spec.db",
  },
});

beforeAll(() => {
  const db = getDb();
  // Drop any leftover test tables
  db.prepare("DROP TABLE IF EXISTS test_items").run();
  db.prepare("DROP TABLE IF EXISTS test_composite").run();
});

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

describe("Table", () => {
  it("should create a table and indexes", () => {
    const table = new Table<TestItem>({
      name: "test_items",
      columns: {
        id: { type: "TEXT", primaryKey: true },
        name: { type: "TEXT", notNull: true },
        value: { type: "INTEGER" },
      },
      indexes: [{ columns: ["name"] }, { columns: ["value"], unique: true }],
    });

    // Verify the table exists by querying sqlite_master
    const db = getDb();
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_items'",
      )
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe("test_items");

    // Verify indexes exist
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='test_items'",
      )
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_test_items_name");
    expect(indexNames).toContain("idx_test_items_value");

    // Clean up for subsequent tests that recreate this table
    void table;
  });

  describe("insert (INSERT OR IGNORE)", () => {
    it("should insert a row", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      table.insert({ id: "1", name: "alpha", value: 10 });
      const rows = table.all();
      expect(rows).toEqual([{ id: "1", name: "alpha", value: 10 }]);
    });

    it("should ignore duplicate primary keys", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      // Insert a duplicate — should be silently ignored
      table.insert({ id: "1", name: "updated-alpha", value: 99 });
      const rows = table.query("id = ?", ["1"]);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("alpha"); // Original value preserved
    });
  });

  describe("upsert (INSERT OR REPLACE)", () => {
    it("should replace an existing row with the same primary key", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      table.upsert({ id: "1", name: "replaced-alpha", value: 42 });
      const rows = table.query("id = ?", ["1"]);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("replaced-alpha");
      expect(rows[0].value).toBe(42);
    });

    it("should insert a new row if key does not exist", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      table.upsert({ id: "2", name: "beta", value: 20 });
      const rows = table.query("id = ?", ["2"]);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("beta");
    });
  });

  describe("query", () => {
    it("should return rows matching a WHERE clause", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      const rows = table.query("value > ?", [15]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.value).toBeGreaterThan(15);
      }
    });
  });

  describe("all", () => {
    it("should return all rows", () => {
      const table = new Table<TestItem>({
        name: "test_items",
        columns: {
          id: { type: "TEXT", primaryKey: true },
          name: { type: "TEXT", notNull: true },
          value: { type: "INTEGER" },
        },
      });

      const rows = table.all();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain("1");
      expect(ids).toContain("2");
    });
  });

  describe("composite primary keys", () => {
    it("should support composite primary keys", () => {
      const table = new Table<CompositeItem>({
        name: "test_composite",
        columns: {
          group_id: { type: "TEXT", primaryKey: true },
          item_id: { type: "TEXT", primaryKey: true },
          label: { type: "TEXT", notNull: true },
        },
      });

      table.insert({ group_id: "g1", item_id: "i1", label: "first" });
      table.insert({ group_id: "g1", item_id: "i2", label: "second" });
      table.insert({ group_id: "g2", item_id: "i1", label: "third" });

      const allRows = table.all();
      expect(allRows).toHaveLength(3);

      // Same composite key should be ignored
      table.insert({ group_id: "g1", item_id: "i1", label: "duplicate" });
      expect(table.all()).toHaveLength(3);
      const row = table.query("group_id = ? AND item_id = ?", ["g1", "i1"]);
      expect(row[0].label).toBe("first");

      // Upsert should replace
      table.upsert({ group_id: "g1", item_id: "i1", label: "replaced" });
      const updated = table.query("group_id = ? AND item_id = ?", ["g1", "i1"]);
      expect(updated[0].label).toBe("replaced");
    });

    it("should query by a single column of the composite key", () => {
      const table = new Table<CompositeItem>({
        name: "test_composite",
        columns: {
          group_id: { type: "TEXT", primaryKey: true },
          item_id: { type: "TEXT", primaryKey: true },
          label: { type: "TEXT", notNull: true },
        },
      });

      const g1Rows = table.query("group_id = ?", ["g1"]);
      expect(g1Rows).toHaveLength(2);
    });
  });
});
