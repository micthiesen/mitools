import { assert, describe, expect, it, layer } from "@effect/vitest";
import { Clock, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "../logging/Logger.js";
import type { LogItem } from "../logging/types.js";
import { LogLevel } from "../logging/types.js";
import {
  CorruptRowError,
  cleanupExpired,
  clearDocstore,
  countByEntity,
  countByPrefix,
  Docstore,
  deleteDoc,
  deleteDocsByEntity,
  deleteDocsByPrefix,
  encodeDoc,
  getDoc,
  getDocsByEntity,
  getDocsByPrefix,
  getKeysByPrefix,
  getRawRow,
  getRawRowsByPrefix,
  hasDoc,
  touchDoc,
  upsertDoc,
} from "./docstore.js";
import { Sqlite } from "./sqlite.js";

// Routes `Effect.logWarning` (used by the docstore for large payloads and
// skipped rows) into an in-memory buffer instead of the console.
const capturing = Logger.layerAdapter.pipe(Layer.provideMerge(Logger.layerCapture()));

const withCapturedLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const value = yield* effect;
    const logs = yield* Logger.captured;
    return [value, logs] as const;
  }).pipe(Effect.provide(Layer.fresh(capturing), { local: true }));

const warnings = (logs: ReadonlyArray<LogItem>) =>
  logs.filter((log) => log.level === LogLevel.WARN).map((log) => log.message);

// Bytes CBOR cannot decode: a map header promising one pair that ends early
// ("Insufficient data"), i.e. a truncated on-disk blob.
const CORRUPT = Buffer.from([0xa1, 0x61, 0x61]);

const corruptRow = (pk: string) =>
  Sqlite.useSync(({ db }) =>
    db
      .prepare("UPDATE blobs SET data = @data WHERE pk = @pk")
      .run({ pk, data: CORRUPT }),
  );

const STORED_DATE = new Date("2020-01-01T00:00:00.000Z");

layer(Docstore.layerMemory)("docstore", (it) => {
  it.effect("stores and retrieves a document through the free accessors", () =>
    Effect.gen(function* () {
      const doc = { foo: "bar", date: STORED_DATE, nested: { list: [1, 2, 3] } };
      yield* upsertDoc("test-pk", doc);

      const retrieved = yield* getDoc<typeof doc>("test-pk");
      assert.isTrue(Option.isSome(retrieved));
      expect(Option.getOrUndefined(retrieved)).toEqual(doc);
    }),
  );

  it.effect("stores and retrieves a document through Docstore.use", () =>
    Effect.gen(function* () {
      yield* Docstore.use((s) => s.upsertDoc("use-pk", { via: "use" }));
      const retrieved = yield* Docstore.use((s) => s.getDoc<{ via: string }>("use-pk"));
      expect(Option.getOrUndefined(retrieved)).toEqual({ via: "use" });
    }),
  );

  it.effect("resolves None for an unknown key", () =>
    Effect.gen(function* () {
      const missing = yield* getDoc("definitely-not-here");
      assert.deepStrictEqual(missing, Option.none());
      assert.isFalse(yield* hasDoc("definitely-not-here"));
    }),
  );

  it.effect("deletes a doc and reports whether it existed", () =>
    Effect.gen(function* () {
      yield* upsertDoc("del-1", { a: 1 });
      assert.isTrue(yield* deleteDoc("del-1"));
      assert.isFalse(yield* deleteDoc("del-1"));
      assert.deepStrictEqual(yield* getDoc("del-1"), Option.none());
    }),
  );

  it.effect("deletes docs by prefix", () =>
    Effect.gen(function* () {
      yield* upsertDoc("pfx:a", 1);
      yield* upsertDoc("pfx:b", 2);
      yield* upsertDoc("other:c", 3);

      assert.strictEqual(yield* deleteDocsByPrefix("pfx:"), 2);
      assert.deepStrictEqual(yield* getDoc("pfx:a"), Option.none());
      assert.deepStrictEqual(yield* getDoc<number>("other:c"), Option.some(3));
    }),
  );

  it.effect("checks existence without deserializing", () =>
    Effect.gen(function* () {
      yield* upsertDoc("exists-check", { x: true });
      assert.isTrue(yield* hasDoc("exists-check"));
      assert.isFalse(yield* hasDoc("nope"));
    }),
  );

  it.effect("counts and lists keys by prefix", () =>
    Effect.gen(function* () {
      yield* upsertDoc("cnt:1", "a");
      yield* upsertDoc("cnt:2", "b");
      yield* upsertDoc("cnt:3", "c");

      assert.strictEqual(yield* countByPrefix("cnt:"), 3);
      assert.strictEqual(yield* countByPrefix("nonexistent:"), 0);

      const keys = yield* getKeysByPrefix("cnt:");
      assert.deepStrictEqual(keys.toSorted(), ["cnt:1", "cnt:2", "cnt:3"]);
    }),
  );

  it.effect("scopes reads, counts and deletes by the entity column", () =>
    Effect.gen(function* () {
      yield* upsertDoc("e:1", { n: 1 }, { entity: "foo" });
      yield* upsertDoc("e:2", { n: 2 }, { entity: "foo" });
      yield* upsertDoc("e:3", { n: 3 }, { entity: "bar" });

      assert.strictEqual(yield* countByEntity("foo"), 2);
      assert.strictEqual((yield* getDocsByEntity("foo")).length, 2);
      assert.strictEqual(yield* deleteDocsByEntity("foo"), 2);
      assert.strictEqual(yield* countByEntity("foo"), 0);
      assert.strictEqual(yield* countByEntity("bar"), 1);
    }),
  );

  it.effect("defaults the metadata columns of a bare upsert", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(1234);
      yield* upsertDoc("meta:bare", { a: 1 });

      const row = Option.getOrThrow(yield* getRawRow("meta:bare"));
      assert.strictEqual(row.entity, null);
      assert.strictEqual(row.version, 0);
      assert.strictEqual(row.expires_at, null);
      assert.strictEqual(row.updated_at, 1234);
    }),
  );

  it.effect("stores the metadata it is given", () =>
    Effect.gen(function* () {
      yield* upsertDoc(
        "meta:full",
        { a: 1 },
        { entity: "widget", version: 3, expiresAt: 60_000, updatedAt: 42 },
      );

      const row = Option.getOrThrow(yield* getRawRow("meta:full"));
      assert.strictEqual(row.entity, "widget");
      assert.strictEqual(row.version, 3);
      assert.strictEqual(row.expires_at, 60_000);
      assert.strictEqual(row.updated_at, 42);
    }),
  );

  it.effect("treats expired rows as absent across every read", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* upsertDoc("exp:live", "a", { expiresAt: now + 60_000 });
      yield* upsertDoc("exp:dead", "b", { expiresAt: -1 });

      assert.deepStrictEqual(yield* getDoc("exp:dead"), Option.none());
      assert.isFalse(yield* hasDoc("exp:dead"));
      assert.deepStrictEqual(yield* getDoc<string>("exp:live"), Option.some("a"));
      assert.strictEqual(yield* countByPrefix("exp:"), 1);
      assert.deepStrictEqual(yield* getKeysByPrefix("exp:"), ["exp:live"]);
      assert.deepStrictEqual(yield* getDocsByPrefix<string>("exp:"), ["a"]);
    }),
  );

  it.effect("expires a row once virtual time passes its expiry", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* upsertDoc("clock:row", "still here", { expiresAt: now + 60_000 });
      assert.isTrue(yield* hasDoc("clock:row"));

      yield* TestClock.adjust(59_999);
      assert.isTrue(yield* hasDoc("clock:row"));

      yield* TestClock.adjust(2);
      assert.isFalse(yield* hasDoc("clock:row"));
      assert.deepStrictEqual(yield* getDoc("clock:row"), Option.none());
    }),
  );

  it.effect("still returns expired rows from the raw prefix scan", () =>
    Effect.gen(function* () {
      yield* upsertDoc("raw:dead", "gone", { expiresAt: -1 });
      const rows = yield* getRawRowsByPrefix("raw:");
      assert.deepStrictEqual(
        rows.map((row) => row.pk),
        ["raw:dead"],
      );
      assert.deepStrictEqual(yield* getRawRow("raw:dead"), Option.none());
    }),
  );

  it.effect("treats LIKE metacharacters in a prefix literally", () =>
    Effect.gen(function* () {
      yield* upsertDoc("a_b:1", 1);
      yield* upsertDoc("aXb:1", 2); // would match `a_b:%` if `_` were a wildcard
      yield* upsertDoc("p%q:1", 3);
      yield* upsertDoc("pZq:1", 4); // would match `p%q:%` if `%` were a wildcard

      assert.strictEqual(yield* countByPrefix("a_b:"), 1);
      assert.deepStrictEqual(yield* getKeysByPrefix("a_b:"), ["a_b:1"]);
      assert.deepStrictEqual(yield* getKeysByPrefix("p%q:"), ["p%q:1"]);
      assert.strictEqual(yield* deleteDocsByPrefix("a_b:"), 1);
      assert.deepStrictEqual(yield* getDoc<number>("aXb:1"), Option.some(2));
      assert.deepStrictEqual(yield* getDoc<number>("pZq:1"), Option.some(4));
    }),
  );

  it.effect(
    "escapes a backslash in a prefix so it cannot break the ESCAPE clause",
    () =>
      Effect.gen(function* () {
        yield* upsertDoc("bs\\_x:1", 1);
        yield* upsertDoc("bs\\Yx:1", 2);

        assert.deepStrictEqual(yield* getKeysByPrefix("bs\\_x:"), ["bs\\_x:1"]);
      }),
  );

  it.effect("touches expiry and physically reclaims expired rows", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      yield* upsertDoc("t:1", "x", { expiresAt: -1 });
      assert.isFalse(yield* touchDoc("t:1", now + 60_000)); // already expired

      yield* upsertDoc("t:2", "y", { expiresAt: now + 60_000 });
      assert.isTrue(yield* touchDoc("t:2", null)); // clears the expiry
      const touched = yield* getRawRow("t:2");
      assert.strictEqual(Option.getOrUndefined(touched)?.expires_at, null);

      yield* upsertDoc("t:3", "z", { expiresAt: -1 });
      assert.isTrue((yield* cleanupExpired()) >= 1);
      assert.deepStrictEqual(yield* getDoc("t:3"), Option.none());
      assert.deepStrictEqual(yield* getRawRowsByPrefix("t:3"), []);
    }),
  );

  it.effect("cleanupExpired honours its limit and leaves live rows alone", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* upsertDoc("lim:a", 1, { expiresAt: -1 });
      yield* upsertDoc("lim:b", 2, { expiresAt: -1 });
      yield* upsertDoc("lim:c", 3, { expiresAt: now + 60_000 });

      assert.strictEqual(yield* cleanupExpired(1), 1);
      assert.strictEqual((yield* getRawRowsByPrefix("lim:")).length, 2);
      assert.strictEqual(yield* cleanupExpired(10), 1);
      assert.deepStrictEqual(
        (yield* getRawRowsByPrefix("lim:")).map((row) => row.pk),
        ["lim:c"],
      );
    }),
  );

  it.effect("runs several statements in one docstore transaction", () =>
    Effect.gen(function* () {
      const written = yield* Docstore.use((s) =>
        s.transaction("write pair", (tx) => {
          tx.upsertDoc("tx:a", { n: 1 }, { entity: "tx" }, 0);
          tx.upsertDoc("tx:b", { n: 2 }, { entity: "tx" }, 0);
          return tx.getRawRow("tx:a", 0)?.pk;
        }),
      );
      assert.strictEqual(written, "tx:a");
      assert.strictEqual(yield* countByEntity("tx"), 2);
    }),
  );

  it.effect("rolls a failed docstore transaction back", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Docstore.use((s) =>
          s.transaction("half write", (tx) => {
            tx.upsertDoc("rb:a", { n: 1 }, {}, 0);
            throw new Error("nope");
          }),
        ),
      );
      assert.strictEqual(error._tag, "OperationError");
      // The docstore delegates to `Sqlite.transaction`, so the failure is
      assert.strictEqual(error.source, "docstore");
      assert.strictEqual(error.operation, "half write");
      assert.deepStrictEqual(yield* getDoc("rb:a"), Option.none());
    }),
  );

  it.effect("clears every row", () =>
    Effect.gen(function* () {
      yield* upsertDoc("clear:1", 1);
      yield* clearDocstore;
      assert.strictEqual(yield* countByPrefix(""), 0);
    }),
  );

  // Regression: cbor's sync encoders truncate output past the ~64KB stream
  // highWaterMark, which silently corrupted every row larger than that.
  it.effect("round-trips payloads larger than the 64KB encoder highWaterMark", () =>
    Effect.gen(function* () {
      for (const size of [66_000, 300_000, 1_000_000]) {
        const doc = { id: size, content: "a".repeat(size), tail: "sounds great!" };
        yield* upsertDoc(`big:${size}`, doc);
        expect(Option.getOrUndefined(yield* getDoc<typeof doc>(`big:${size}`))).toEqual(
          doc,
        );
      }
    }),
  );

  it("encodeDoc emits every chunk of a large payload", () => {
    const encoded = encodeDoc({ content: "a".repeat(300_000) });
    assert.isTrue(encoded.length > 300_000);
  });
});

layer(Docstore.layerMemory)("docstore warnings", (it) => {
  it.effect("warns once when an encoded payload exceeds the large-doc threshold", () =>
    Effect.gen(function* () {
      const big = { content: "a".repeat(400_000) };
      const [, logs] = yield* withCapturedLogs(
        Effect.gen(function* () {
          yield* upsertDoc("small:doc", { content: "a".repeat(1000) });
          yield* upsertDoc("big:doc", big);
        }),
      );

      const warned = warnings(logs);
      assert.deepStrictEqual(
        warned.filter((message) => message.includes("small:doc")),
        [],
      );
      const bigWarnings = warned.filter((message) => message.includes("big:doc"));
      assert.strictEqual(bigWarnings.length, 1);
      assert.match(bigWarnings[0], /Large docstore payload/);

      // Warned, not blocked: the row is still stored intact.
      expect(Option.getOrUndefined(yield* getDoc<typeof big>("big:doc"))).toEqual(big);
    }),
  );
});

layer(Docstore.layerMemory)("docstore corrupt rows", (it) => {
  it.effect("skips an unreadable row in getDocsByEntity without failing the read", () =>
    Effect.gen(function* () {
      yield* upsertDoc("crp:1", { n: 1 }, { entity: "crp" });
      yield* upsertDoc("crp:bad", { n: 2 }, { entity: "crp" });
      yield* upsertDoc("crp:3", { n: 3 }, { entity: "crp" });
      yield* corruptRow("crp:bad");

      const [docs, logs] = yield* withCapturedLogs(
        getDocsByEntity<{ n: number }>("crp"),
      );
      assert.deepStrictEqual(docs, [{ n: 1 }, { n: 3 }]);
      assert.strictEqual(yield* countByEntity("crp"), 3); // still on disk, repairable

      const warned = warnings(logs);
      assert.strictEqual(warned.length, 1);
      assert.match(warned[0], /Skipping unreadable docstore row "crp:bad"/);
    }),
  );

  it.effect("skips an unreadable row in getDocsByPrefix", () =>
    Effect.gen(function* () {
      yield* upsertDoc("cpf:1", "a");
      yield* upsertDoc("cpf:bad", "b");
      yield* corruptRow("cpf:bad");

      assert.deepStrictEqual(yield* getDocsByPrefix<string>("cpf:"), ["a"]);
    }),
  );

  it.effect("fails loud on a corrupt point read so callers can repair the row", () =>
    Effect.gen(function* () {
      yield* upsertDoc("cone:1", { ok: true });
      yield* corruptRow("cone:1");

      // A point read must fail (not read as absent): tooling relies on the
      // decode error to surface the row as malformed and offer exact-key
      // deletion. Collection reads skip; getDoc does not.
      const error = yield* Effect.flip(getDoc("cone:1"));
      assert.instanceOf(error, CorruptRowError);
      assert.strictEqual(error._tag, "CorruptRowError");
      assert.strictEqual((error as CorruptRowError).pk, "cone:1");
      assert.match(error.message, /unreadable docstore row "cone:1"/);

      // ...while metadata-only reads stay usable for the repair tool.
      assert.isTrue(yield* hasDoc("cone:1"));
      assert.isTrue(Option.isSome(yield* getRawRow("cone:1")));
      assert.isTrue(yield* deleteDoc("cone:1"));
    }),
  );
});

describe("Docstore schema", () => {
  it.effect("initializes the blobs schema and its indexes", () =>
    Effect.gen(function* () {
      const names = yield* Sqlite.useSync(
        ({ db }) =>
          db
            .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'blobs'")
            .all() as { name: string }[],
      ).pipe(Effect.provide(Layer.fresh(Docstore.layerMemory), { local: true }));

      const flat = names.map((row) => row.name);
      assert.include(flat, "blobs");
      assert.include(flat, "blobs_entity_idx");
      assert.include(flat, "blobs_expiry_idx");
    }),
  );

  it.effect("adds the metadata columns to a pre-existing legacy blobs table", () =>
    Effect.gen(function* () {
      const { db } = yield* Sqlite;
      db.exec("CREATE TABLE blobs (pk TEXT PRIMARY KEY, data BLOB)");
      db.prepare("INSERT INTO blobs (pk, data) VALUES (?, ?)").run(
        "legacy",
        encodeDoc({ v: 1 }),
      );

      const doc = yield* getDoc<{ v: number }>("legacy").pipe(
        Effect.provide(Layer.fresh(Docstore.layer), { local: true }),
      );
      expect(Option.getOrUndefined(doc)).toEqual({ v: 1 });

      const columns = (
        db.prepare("PRAGMA table_info(blobs)").all() as { name: string }[]
      ).map((column) => column.name);
      assert.includeMembers(columns, [
        "pk",
        "data",
        "entity",
        "version",
        "expires_at",
        "updated_at",
      ]);
    }).pipe(Effect.provide(Layer.fresh(Sqlite.layerMemory), { local: true })),
  );
});
