import { assert, describe, expect, it as it_, layer } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "../logging/Logger.js";
import type { LogItem } from "../logging/types.js";
import { LogLevel } from "../logging/types.js";
import {
  clearDocstore,
  Docstore,
  getKeysByPrefix,
  getRawRow,
  upsertDoc,
} from "./docstore.js";
import { Entity } from "./entities.js";
import { Sqlite } from "./sqlite.js";

const capturing = Logger.layerAdapter.pipe(Layer.provideMerge(Logger.layerCapture()));

const withCapturedLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const value = yield* effect;
    const logs = yield* Logger.captured;
    return [value, logs] as const;
  }).pipe(Effect.provide(Layer.fresh(capturing), { local: true }));

const warnings = (logs: ReadonlyArray<LogItem>) =>
  logs.filter((log) => log.level === LogLevel.WARN).map((log) => log.message);

const expiresAtOf = (pk: string) =>
  Effect.map(getRawRow(pk), (row) => Option.getOrUndefined(row)?.expires_at);

interface Doc {
  id: string;
  name: string;
  score: number;
}
const DocEntity = new Entity<Doc, ["id"]>("doc", ["id"]);

interface Note {
  id: string;
  body: string;
}
const NoteEntity = new Entity<Note, ["id"]>("note", ["id"]);
const TtlEntity = new Entity<Note, ["id"]>({
  name: "ttl-note",
  pk: ["id"],
  defaultTtlMs: 60_000,
});

interface Multi {
  a: string;
  b: string;
  v: number;
}
const MultiEntity = new Entity<Multi, ["a", "b"]>("multi", ["a", "b"]);

interface Typed {
  k: string | number | boolean;
}
const TypedEntity = new Entity<Typed, ["k"]>("typed", ["k"]);

const ValidatedEntity = new Entity<Doc, ["id"]>({
  name: "validated",
  pk: ["id"],
  validate: (data) => {
    const doc = data as Doc;
    if (typeof doc.name !== "string") throw new Error("name must be a string");
    return { ...doc, name: doc.name.trim() };
  },
});

interface V2 {
  id: string;
  label: string;
  score: number;
}
const V2Entity = new Entity<V2, ["id"]>({
  name: "versioned",
  pk: ["id"],
  version: 2,
  migrate: (data, from) => {
    const d = data as Record<string, unknown>;
    let out = { ...d };
    if (from < 1) out = { ...out, label: out.title, title: undefined };
    if (from < 2) out = { ...out, score: out.score ?? 0 };
    return { id: out.id, label: out.label, score: out.score } as V2;
  },
});

const MigNoteEntity = new Entity<Note, ["id"]>("mignote", ["id"]);

interface User {
  name: string;
  email: string;
}
const UserEntity = new Entity<User, ["name"]>("user", ["name"]);

layer(Docstore.layerMemory)("entities", (it) => {
  describe("basic operations", () => {
    it.effect("builds a storage key and round-trips a document", () =>
      Effect.gen(function* () {
        assert.strictEqual(DocEntity.getPk({ id: "hi" }), "$doc#s2:hi");
        assert.deepStrictEqual(yield* DocEntity.get({ id: "hi" }), Option.none());

        const doc: Doc = { id: "hi", name: "hello", score: 10 };
        yield* DocEntity.upsert(doc);
        expect(Option.getOrUndefined(yield* DocEntity.get(doc))).toEqual(doc);
      }),
    );

    it.effect("stamps the entity name and version onto the row", () =>
      Effect.gen(function* () {
        yield* V2Entity.upsert({ id: "stamped", label: "L", score: 1 });
        const row = Option.getOrThrow(
          yield* getRawRow(V2Entity.getPk({ id: "stamped" })),
        );
        assert.strictEqual(row.entity, "versioned");
        assert.strictEqual(row.version, 2);
      }),
    );

    it.effect("deletes a single entity and reports whether it existed", () =>
      Effect.gen(function* () {
        yield* DocEntity.upsert({ id: "del", name: "gone", score: 0 });
        assert.isTrue(yield* DocEntity.delete({ id: "del" }));
        assert.isFalse(yield* DocEntity.delete({ id: "del" }));
        assert.deepStrictEqual(yield* DocEntity.get({ id: "del" }), Option.none());
      }),
    );

    it.effect("deletes every entity of a type without touching its neighbours", () =>
      Effect.gen(function* () {
        yield* DocEntity.deleteAll();
        yield* NoteEntity.deleteAll();
        yield* DocEntity.upsert({ id: "a", name: "A", score: 1 });
        yield* DocEntity.upsert({ id: "b", name: "B", score: 2 });
        yield* NoteEntity.upsert({ id: "keep", body: "kept" });

        assert.strictEqual(yield* DocEntity.deleteAll(), 2);
        assert.deepStrictEqual(yield* DocEntity.getAll(), []);
        assert.strictEqual(yield* NoteEntity.count(), 1);
      }),
    );

    it.effect("checks existence and counts", () =>
      Effect.gen(function* () {
        yield* DocEntity.deleteAll();
        yield* DocEntity.upsert({ id: "c1", name: "C1", score: 1 });
        yield* DocEntity.upsert({ id: "c2", name: "C2", score: 2 });
        assert.isTrue(yield* DocEntity.has({ id: "c1" }));
        assert.isFalse(yield* DocEntity.has({ id: "nope" }));
        assert.strictEqual(yield* DocEntity.count(), 2);
      }),
    );

    it.effect("lists structured primary keys", () =>
      Effect.gen(function* () {
        yield* DocEntity.deleteAll();
        yield* DocEntity.upsert({ id: "k1", name: "K1", score: 1 });
        yield* DocEntity.upsert({ id: "k2", name: "K2", score: 2 });

        const keys = yield* DocEntity.keys();
        assert.deepStrictEqual(
          keys.toSorted((l, r) => l.id.localeCompare(r.id)),
          [{ id: "k1" }, { id: "k2" }],
        );
      }),
    );
  });

  describe("patch and update", () => {
    it.effect("patches an entity and re-asserts pk fields from the argument", () =>
      Effect.gen(function* () {
        yield* DocEntity.upsert({ id: "p", name: "original", score: 0 });

        const patched = yield* DocEntity.patch({ id: "p" }, {
          name: "updated",
          id: "hijack",
        } as Partial<Omit<Doc, "id">>);

        expect(Option.getOrUndefined(patched)).toEqual({
          id: "p",
          name: "updated",
          score: 0,
        });
        expect(Option.getOrUndefined(yield* DocEntity.get({ id: "p" }))).toEqual({
          id: "p",
          name: "updated",
          score: 0,
        });
        assert.deepStrictEqual(yield* DocEntity.get({ id: "hijack" }), Option.none());
      }),
    );

    it.effect("resolves None when patching a nonexistent entity", () =>
      Effect.gen(function* () {
        const patched = yield* DocEntity.patch({ id: "ghost" }, { name: "nope" });
        assert.deepStrictEqual(patched, Option.none());
        assert.isFalse(yield* DocEntity.has({ id: "ghost" }));
      }),
    );

    it.effect("updates transactionally through a callback", () =>
      Effect.gen(function* () {
        yield* DocEntity.upsert({ id: "u", name: "u", score: 1 });
        const result = yield* DocEntity.update({ id: "u" }, (cur) => ({
          ...cur,
          score: cur.score + 41,
        }));
        expect(Option.getOrUndefined(result)).toEqual({
          id: "u",
          name: "u",
          score: 42,
        });
        assert.strictEqual(
          Option.getOrUndefined(yield* DocEntity.get({ id: "u" }))?.score,
          42,
        );

        const missing = yield* DocEntity.update({ id: "missing" }, (cur) => cur);
        assert.deepStrictEqual(missing, Option.none());
      }),
    );

    it.effect("leaves the row untouched when the update callback throws", () =>
      Effect.gen(function* () {
        yield* DocEntity.upsert({ id: "boom", name: "before", score: 1 });
        const error = yield* Effect.flip(
          DocEntity.update({ id: "boom" }, () => {
            throw new Error("callback exploded");
          }),
        );
        assert.strictEqual(error._tag, "OperationError");
        assert.strictEqual(
          Option.getOrUndefined(yield* DocEntity.get({ id: "boom" }))?.name,
          "before",
        );
      }),
    );
  });

  describe("key codec", () => {
    it.effect("does not collide when a delimiter appears inside a component", () =>
      Effect.gen(function* () {
        yield* MultiEntity.deleteAll();
        const left: Multi = { a: "x#y", b: "z", v: 1 };
        const right: Multi = { a: "x", b: "y#z", v: 2 };
        assert.notStrictEqual(MultiEntity.getPk(left), MultiEntity.getPk(right));

        yield* MultiEntity.upsert(left);
        yield* MultiEntity.upsert(right);
        expect(Option.getOrUndefined(yield* MultiEntity.get(left))).toEqual(left);
        expect(Option.getOrUndefined(yield* MultiEntity.get(right))).toEqual(right);
        assert.strictEqual(yield* MultiEntity.count(), 2);
      }),
    );

    it_('tags each component type so 1, "1" and true stay distinct', () => {
      const asNumber = TypedEntity.getPk({ k: 1 });
      const asString = TypedEntity.getPk({ k: "1" });
      const asBoolean = TypedEntity.getPk({ k: true });
      assert.strictEqual(asNumber, "$typed#n1");
      assert.strictEqual(asString, "$typed#s1:1");
      assert.strictEqual(asBoolean, "$typed#b1");
      assert.strictEqual(new Set([asNumber, asString, asBoolean]).size, 3);
    });

    it_("throws InvalidKeyError synchronously on a non-primitive pk value", () => {
      expect(() => TypedEntity.getPk({ k: undefined as unknown as string })).toThrow(
        /Invalid primary-key value for "typed.k"/,
      );
    });

    it.effect("fails typed with InvalidKeyError from the effectful methods", () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.result(
          TypedEntity.get({ k: undefined as unknown as string }),
        );
        assert.isTrue(Result.isFailure(outcome));
        if (Result.isFailure(outcome)) {
          assert.strictEqual(outcome.failure._tag, "InvalidKeyError");
        }
      }),
    );

    it_("rejects an entity name containing '#'", () => {
      expect(() => new Entity<Doc, ["id"]>("a#b", ["id"])).toThrow(/may not contain/);
    });
  });

  describe("validation", () => {
    it.effect("stores what validate returns", () =>
      Effect.gen(function* () {
        yield* ValidatedEntity.upsert({ id: "v", name: "  padded  ", score: 1 });
        assert.strictEqual(
          Option.getOrUndefined(yield* ValidatedEntity.get({ id: "v" }))?.name,
          "padded",
        );
      }),
    );

    it.effect("fails with EntityValidationError when validate throws", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          ValidatedEntity.upsert({ id: "bad", name: 7 as unknown as string, score: 1 }),
        );
        assert.strictEqual(error._tag, "EntityValidationError");
        assert.strictEqual(
          error.message,
          'Invalid "validated" payload: name must be a string',
        );
        assert.isFalse(yield* ValidatedEntity.has({ id: "bad" }));
      }),
    );

    it.effect("runs validate on the result of update and patch", () =>
      Effect.gen(function* () {
        yield* ValidatedEntity.upsert({ id: "upd", name: " Ada ", score: 1 });
        const patched = yield* ValidatedEntity.patch({ id: "upd" }, { name: "  Lin " });
        assert.deepStrictEqual(Option.getOrUndefined(patched), {
          id: "upd",
          name: "Lin",
          score: 1,
        });
        const error = yield* Effect.flip(
          ValidatedEntity.update({ id: "upd" }, (cur) => ({
            ...cur,
            name: 9 as unknown as string,
          })),
        );
        assert.strictEqual(error._tag, "EntityValidationError");
        // The rejected write rolled back.
        assert.strictEqual(
          Option.getOrUndefined(yield* ValidatedEntity.get({ id: "upd" }))?.name,
          "Lin",
        );
      }),
    );
  });

  describe("expiry", () => {
    it.effect("hides expired entities from every read", () =>
      Effect.gen(function* () {
        yield* NoteEntity.deleteAll();
        yield* NoteEntity.upsert({ id: "live", body: "here" }, { ttlMs: 60_000 });
        yield* NoteEntity.upsert({ id: "dead", body: "gone" }, { expiresAt: -1 });

        assert.deepStrictEqual(yield* NoteEntity.get({ id: "dead" }), Option.none());
        assert.isFalse(yield* NoteEntity.has({ id: "dead" }));
        assert.strictEqual(
          Option.getOrUndefined(yield* NoteEntity.get({ id: "live" }))?.body,
          "here",
        );
        assert.strictEqual(yield* NoteEntity.count(), 1);
        assert.strictEqual((yield* NoteEntity.getAll()).length, 1);
        assert.deepStrictEqual(yield* NoteEntity.keys(), [{ id: "live" }]);
      }),
    );

    it.effect("expires a ttlMs row when virtual time passes it", () =>
      Effect.gen(function* () {
        yield* NoteEntity.upsert({ id: "ttl", body: "x" }, { ttlMs: 60_000 });
        assert.isTrue(yield* NoteEntity.has({ id: "ttl" }));
        yield* TestClock.adjust(60_001);
        assert.isFalse(yield* NoteEntity.has({ id: "ttl" }));
      }),
    );

    it.effect("touch refuses a dead row, extends a live one and can clear expiry", () =>
      Effect.gen(function* () {
        yield* NoteEntity.upsert({ id: "x", body: "x" }, { expiresAt: -1 });
        assert.isFalse(yield* NoteEntity.touch({ id: "x" }, { ttlMs: 60_000 }));

        yield* NoteEntity.upsert({ id: "y", body: "y" }, { ttlMs: 1_000 });
        assert.isTrue(yield* NoteEntity.touch({ id: "y" }, { ttlMs: 60_000 }));
        const now = yield* Clock.currentTimeMillis;
        assert.strictEqual(
          yield* expiresAtOf(NoteEntity.getPk({ id: "y" })),
          now + 60_000,
        );

        assert.isTrue(yield* NoteEntity.touch({ id: "y" }));
        assert.strictEqual(yield* expiresAtOf(NoteEntity.getPk({ id: "y" })), null);
      }),
    );

    it.effect("cleanupExpired physically reclaims expired rows", () =>
      Effect.gen(function* () {
        yield* NoteEntity.upsert({ id: "z", body: "z" }, { expiresAt: -1 });
        assert.isTrue((yield* NoteEntity.cleanupExpired()) >= 1);
        const keys = yield* getKeysByPrefix("$note#");
        assert.notInclude(keys, NoteEntity.getPk({ id: "z" }));
      }),
    );

    it.effect("applies a default TTL when configured", () =>
      Effect.gen(function* () {
        yield* TtlEntity.upsert({ id: "d", body: "d" });
        const now = yield* Clock.currentTimeMillis;
        assert.strictEqual(
          Option.getOrUndefined(yield* TtlEntity.get({ id: "d" }))?.body,
          "d",
        );
        assert.strictEqual(
          yield* expiresAtOf(TtlEntity.getPk({ id: "d" })),
          now + 60_000,
        );
      }),
    );

    it.effect("preserves an existing expiry across patch and update", () =>
      Effect.gen(function* () {
        const soon = (yield* Clock.currentTimeMillis) + 60_000;
        yield* NoteEntity.upsert({ id: "p", body: "p" }, { expiresAt: soon });

        yield* NoteEntity.patch({ id: "p" }, { body: "patched" });
        assert.strictEqual(yield* expiresAtOf(NoteEntity.getPk({ id: "p" })), soon);

        yield* NoteEntity.update({ id: "p" }, (cur) => ({ ...cur, body: "updated" }));
        assert.strictEqual(yield* expiresAtOf(NoteEntity.getPk({ id: "p" })), soon);
      }),
    );

    it.effect("does not silently reapply defaultTtlMs on a patch", () =>
      Effect.gen(function* () {
        yield* TtlEntity.upsert({ id: "keep", body: "keep" });
        const original = yield* expiresAtOf(TtlEntity.getPk({ id: "keep" }));

        yield* TestClock.adjust(10_000);
        yield* TtlEntity.patch({ id: "keep" }, { body: "patched" });

        assert.strictEqual(
          yield* expiresAtOf(TtlEntity.getPk({ id: "keep" })),
          original,
        );
      }),
    );

    it.effect("lets patch and update override the expiry when asked", () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* NoteEntity.upsert({ id: "q", body: "q" }, { expiresAt: now + 60_000 });

        const later = now + 120_000;
        yield* NoteEntity.patch({ id: "q" }, { body: "q2" }, { expiresAt: later });
        assert.strictEqual(yield* expiresAtOf(NoteEntity.getPk({ id: "q" })), later);

        yield* NoteEntity.update({ id: "q" }, (cur) => cur, { ttlMs: 5_000 });
        assert.strictEqual(
          yield* expiresAtOf(NoteEntity.getPk({ id: "q" })),
          now + 5_000,
        );
      }),
    );
  });

  describe("migration", () => {
    it.effect("rewrites legacy rows into the new key, version and entity column", () =>
      Effect.gen(function* () {
        yield* clearDocstore;
        // A pre-migration row: legacy concatenated key, entity NULL, version 0.
        yield* upsertDoc("$versioned#old", { id: "old", title: "Legacy", score: 3 });

        assert.strictEqual(yield* V2Entity.migrate(), 1);

        expect(Option.getOrUndefined(yield* V2Entity.get({ id: "old" }))).toEqual({
          id: "old",
          label: "Legacy",
          score: 3,
        });
        assert.deepStrictEqual(yield* getKeysByPrefix("$versioned#"), [
          V2Entity.getPk({ id: "old" }),
        ]);

        const row = yield* getRawRow(V2Entity.getPk({ id: "old" }));
        assert.strictEqual(Option.getOrUndefined(row)?.entity, "versioned");
        assert.strictEqual(Option.getOrUndefined(row)?.version, 2);

        // Idempotent: a second pass rewrites nothing.
        assert.strictEqual(yield* V2Entity.migrate(), 0);
      }),
    );

    it.effect("preserves the expiry of a migrated row", () =>
      Effect.gen(function* () {
        yield* clearDocstore;
        const expiresAt = (yield* Clock.currentTimeMillis) + 60_000;
        yield* upsertDoc(
          "$versioned#exp",
          { id: "exp", title: "Expiring", score: 1 },
          { expiresAt },
        );

        assert.strictEqual(yield* V2Entity.migrate(), 1);
        assert.strictEqual(
          yield* expiresAtOf(V2Entity.getPk({ id: "exp" })),
          expiresAt,
        );
      }),
    );

    it.effect("migrateAll runs across every registered entity", () =>
      Effect.gen(function* () {
        yield* clearDocstore;
        yield* upsertDoc("$versioned#again", { id: "again", title: "Again", score: 1 });
        assert.isTrue((yield* Entity.migrateAll()) >= 1);
        assert.strictEqual(
          Option.getOrUndefined(yield* V2Entity.get({ id: "again" }))?.label,
          "Again",
        );
      }),
    );

    it.effect("isolates an undecodable row instead of aborting the migration", () =>
      Effect.gen(function* () {
        yield* clearDocstore;
        const { db } = yield* Sqlite;

        // Two good legacy rows straddling a corrupt one. The corrupt payload
        // would throw in the decoder; migration must skip it, not crash.
        yield* upsertDoc("$mignote#a", { id: "a", body: "first" });
        db.prepare(
          "INSERT INTO blobs (pk, entity, version, expires_at, updated_at, data)" +
            " VALUES (?, NULL, 0, NULL, 0, ?)",
        ).run("$mignote#bad", Buffer.from([0xff, 0xff, 0xff]));
        yield* upsertDoc("$mignote#c", { id: "c", body: "third" });

        const [migrated, logs] = yield* withCapturedLogs(MigNoteEntity.migrate());
        assert.strictEqual(migrated, 2);
        assert.strictEqual(
          Option.getOrUndefined(yield* MigNoteEntity.get({ id: "a" }))?.body,
          "first",
        );
        assert.strictEqual(
          Option.getOrUndefined(yield* MigNoteEntity.get({ id: "c" }))?.body,
          "third",
        );

        // The corrupt row keeps its original key: still visible, still
        // repairable, rather than silently dropped.
        assert.include(yield* getKeysByPrefix("$mignote#"), "$mignote#bad");

        const warned = warnings(logs);
        assert.strictEqual(warned.length, 1);
        assert.match(warned[0], /Skipping migration of "\$mignote#bad"/);
      }),
    );

    it.effect("does not clobber a live row with a stale legacy duplicate", () =>
      Effect.gen(function* () {
        yield* clearDocstore;

        // A fresh row written by the new code...
        yield* UserEntity.upsert({ name: "alice", email: "fresh@example.com" });
        // ...alongside a leftover legacy row for the same logical key.
        yield* upsertDoc("$user#alice", {
          name: "alice",
          email: "stale@example.com",
        });

        const [, logs] = yield* withCapturedLogs(UserEntity.migrate());

        assert.strictEqual(
          Option.getOrUndefined(yield* UserEntity.get({ name: "alice" }))?.email,
          "fresh@example.com",
        );
        const warned = warnings(logs);
        assert.strictEqual(warned.length, 1);
        assert.match(warned[0], /target key ".*" is already occupied/);
        // The skipped source row is left in place for a human to inspect.
        assert.include(yield* getKeysByPrefix("$user#"), "$user#alice");
      }),
    );
  });
});
