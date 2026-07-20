import { beforeEach, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import { clearDocstore, getKeysByPrefix, getRawRow, upsertDoc } from "./docstore.js";
import { Entity } from "./entities.js";

interface Doc {
  id: string;
  name: string;
  score: number;
}
const DocEntity = new Entity<Doc, ["id"]>("doc", ["id"]);

Injector.configure({
  config: {
    LOG_LEVEL: LogLevel.DEBUG,
    PUSHOVER_TOKEN: "fake-token",
    PUSHOVER_USER: "fake-user",
    DOCKERIZED: false,
    DB_NAME: "entities.spec.db",
  },
});
beforeEach(() => clearDocstore());

describe("entities", () => {
  it("should get and upsert entities", () => {
    const pk = DocEntity.getPk({ id: "hi" });
    expect(pk).toEqual("$doc#s2:hi");

    expect(DocEntity.get({ id: "hi" })).toBeUndefined();

    const doc: Doc = { id: "hi", name: "hello", score: 10 };
    DocEntity.upsert(doc);
    expect(DocEntity.get(doc)).toEqual(doc);
  });

  it("should delete a single entity", () => {
    DocEntity.upsert({ id: "del", name: "gone", score: 0 });
    expect(DocEntity.delete({ id: "del" })).toBe(true);
    expect(DocEntity.delete({ id: "del" })).toBe(false);
    expect(DocEntity.get({ id: "del" })).toBeUndefined();
  });

  it("should delete all entities of a type", () => {
    DocEntity.upsert({ id: "a", name: "A", score: 1 });
    DocEntity.upsert({ id: "b", name: "B", score: 2 });
    expect(DocEntity.deleteAll()).toBe(2);
    expect(DocEntity.getAll()).toEqual([]);
  });

  it("should check existence", () => {
    DocEntity.upsert({ id: "ex", name: "exists", score: 5 });
    expect(DocEntity.has({ id: "ex" })).toBe(true);
    expect(DocEntity.has({ id: "nope" })).toBe(false);
  });

  it("should count entities", () => {
    DocEntity.upsert({ id: "c1", name: "C1", score: 1 });
    DocEntity.upsert({ id: "c2", name: "C2", score: 2 });
    DocEntity.upsert({ id: "c3", name: "C3", score: 3 });
    expect(DocEntity.count()).toBe(3);
  });

  it("should patch an entity and ignore pk fields in the partial", () => {
    DocEntity.upsert({ id: "p", name: "original", score: 0 });

    const patched = DocEntity.patch({ id: "p" }, {
      name: "updated",
      id: "hijack",
    } as Partial<Omit<Doc, "id">>);
    expect(patched).toEqual({ id: "p", name: "updated", score: 0 });
    expect(DocEntity.get({ id: "p" })).toEqual({ id: "p", name: "updated", score: 0 });
    expect(DocEntity.get({ id: "hijack" })).toBeUndefined();
  });

  it("should return undefined when patching a nonexistent entity", () => {
    expect(DocEntity.patch({ id: "ghost" }, { name: "nope" })).toBeUndefined();
  });

  it("should update transactionally", () => {
    DocEntity.upsert({ id: "u", name: "u", score: 1 });
    const result = DocEntity.update({ id: "u" }, (cur) => ({
      ...cur,
      score: cur.score + 41,
    }));
    expect(result).toEqual({ id: "u", name: "u", score: 42 });
    expect(DocEntity.get({ id: "u" })?.score).toBe(42);
    expect(DocEntity.update({ id: "missing" }, (cur) => cur)).toBeUndefined();
  });

  it("should list structured keys", () => {
    DocEntity.upsert({ id: "k1", name: "K1", score: 1 });
    DocEntity.upsert({ id: "k2", name: "K2", score: 2 });

    const keys = DocEntity.keys();
    expect(keys).toEqual(expect.arrayContaining([{ id: "k1" }, { id: "k2" }]));
    expect(keys).toHaveLength(2);
  });
});

describe("entity key codec", () => {
  interface Multi {
    a: string;
    b: string;
    v: number;
  }
  const MultiEntity = new Entity<Multi, ["a", "b"]>("multi", ["a", "b"]);

  it("does not collide when a delimiter appears inside a component", () => {
    const left: Multi = { a: "x#y", b: "z", v: 1 };
    const right: Multi = { a: "x", b: "y#z", v: 2 };
    expect(MultiEntity.getPk(left)).not.toEqual(MultiEntity.getPk(right));

    MultiEntity.upsert(left);
    MultiEntity.upsert(right);
    expect(MultiEntity.get(left)).toEqual(left);
    expect(MultiEntity.get(right)).toEqual(right);
    expect(MultiEntity.count()).toBe(2);
  });

  it("distinguishes number and string components by type", () => {
    interface Typed {
      k: string | number;
    }
    const TypedEntity = new Entity<Typed, ["k"]>("typed", ["k"]);
    expect(TypedEntity.getPk({ k: 1 })).not.toEqual(TypedEntity.getPk({ k: "1" }));
  });

  it("throws on non-primitive pk values", () => {
    interface Bad {
      k: string;
    }
    const BadEntity = new Entity<Bad, ["k"]>("bad", ["k"]);
    expect(() => BadEntity.getPk({ k: undefined as unknown as string })).toThrow(
      /Invalid primary-key/,
    );
  });
});

describe("entity expiry", () => {
  interface Note {
    id: string;
    body: string;
  }
  const NoteEntity = new Entity<Note, ["id"]>("note", ["id"]);

  it("hides expired entities from every read", () => {
    NoteEntity.upsert({ id: "live", body: "here" }, { ttlMs: 60_000 });
    NoteEntity.upsert({ id: "dead", body: "gone" }, { expiresAt: Date.now() - 1 });

    expect(NoteEntity.get({ id: "dead" })).toBeUndefined();
    expect(NoteEntity.has({ id: "dead" })).toBe(false);
    expect(NoteEntity.get({ id: "live" })?.body).toBe("here");
    expect(NoteEntity.count()).toBe(1);
    expect(NoteEntity.getAll()).toHaveLength(1);
    expect(NoteEntity.keys()).toEqual([{ id: "live" }]);
  });

  it("touch extends an expiry and cleanupExpired reclaims rows", () => {
    NoteEntity.upsert({ id: "x", body: "x" }, { expiresAt: Date.now() - 1 });
    expect(NoteEntity.touch({ id: "x" }, { ttlMs: 60_000 })).toBe(false); // already dead

    NoteEntity.upsert({ id: "y", body: "y" }, { expiresAt: Date.now() - 1 });
    expect(NoteEntity.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(getKeysByPrefix("$note#")).not.toContain(NoteEntity.getPk({ id: "y" }));
  });

  it("applies a default TTL when configured", () => {
    const TtlEntity = new Entity<Note, ["id"]>({
      name: "ttl-note",
      pk: ["id"],
      defaultTtlMs: 60_000,
    });
    TtlEntity.upsert({ id: "d", body: "d" });
    expect(TtlEntity.get({ id: "d" })?.body).toBe("d");
  });

  it("preserves an existing expiry across patch and update", () => {
    const soon = Date.now() + 60_000;
    NoteEntity.upsert({ id: "p", body: "p" }, { expiresAt: soon });

    NoteEntity.patch({ id: "p" }, { body: "patched" });
    expect(getRawRow(NoteEntity.getPk({ id: "p" }))?.expires_at).toBe(soon);

    NoteEntity.update({ id: "p" }, (cur) => ({ ...cur, body: "updated" }));
    expect(getRawRow(NoteEntity.getPk({ id: "p" }))?.expires_at).toBe(soon);
  });

  it("lets patch/update override expiry when asked", () => {
    NoteEntity.upsert({ id: "q", body: "q" }, { expiresAt: Date.now() + 60_000 });
    const later = Date.now() + 120_000;
    NoteEntity.patch({ id: "q" }, { body: "q2" }, { expiresAt: later });
    expect(getRawRow(NoteEntity.getPk({ id: "q" }))?.expires_at).toBe(later);
  });
});

describe("entity migration", () => {
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

  it("rewrites legacy rows into the new key + version + entity column", () => {
    // Seed a pre-migration row: legacy concatenated key, entity NULL, version 0.
    upsertDoc("$versioned#old", { id: "old", title: "Legacy", score: 3 });

    expect(V2Entity.migrate()).toBe(1);

    const migrated = V2Entity.get({ id: "old" });
    expect(migrated).toEqual({ id: "old", label: "Legacy", score: 3 });
    // Re-keyed under the new codec, old key gone.
    const keys = getKeysByPrefix("$versioned#");
    expect(keys).toEqual([V2Entity.getPk({ id: "old" })]);

    // Idempotent: a second pass rewrites nothing.
    expect(V2Entity.migrate()).toBe(0);
  });

  it("migrateAll runs across all registered entities", () => {
    upsertDoc("$versioned#again", { id: "again", title: "Again", score: 1 });
    expect(Entity.migrateAll()).toBeGreaterThanOrEqual(1);
    expect(V2Entity.get({ id: "again" })?.label).toBe("Again");
  });

  it("does not clobber a live row with a stale legacy duplicate", () => {
    interface User {
      name: string;
      email: string;
    }
    const UserEntity = new Entity<User, ["name"]>("user", ["name"]);

    // A fresh row written by the new code...
    UserEntity.upsert({ name: "alice", email: "fresh@example.com" });
    // ...alongside a leftover legacy row for the same logical key.
    upsertDoc("$user#alice", { name: "alice", email: "stale@example.com" });

    UserEntity.migrate();

    // The live row survives; the stale legacy row did not overwrite it.
    expect(UserEntity.get({ name: "alice" })?.email).toBe("fresh@example.com");
  });
});

describe("entity name validation", () => {
  it("rejects a name containing '#'", () => {
    interface X {
      id: string;
    }
    expect(() => new Entity<X, ["id"]>("a#b", ["id"])).toThrow(/may not contain/);
  });
});
