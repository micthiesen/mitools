import { beforeAll, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import {
  cleanupExpired,
  clearDocstore,
  countByEntity,
  countByPrefix,
  deleteDoc,
  deleteDocsByEntity,
  deleteDocsByPrefix,
  getDoc,
  getDocsByEntity,
  getKeysByPrefix,
  hasDoc,
  touchDoc,
  upsertDoc,
} from "./docstore.js";

Injector.configure({
  config: {
    LOG_LEVEL: LogLevel.DEBUG,
    PUSHOVER_TOKEN: "fake-token",
    PUSHOVER_USER: "fake-user",
    DOCKERIZED: false,
    DB_NAME: "docstore.spec.db",
  },
});
beforeAll(() => clearDocstore());

describe("docstore", () => {
  it("should store and retrieve a blob", () => {
    const pk = "test-pk";
    const doc = { foo: "bar", date: new Date("2020-01-01") };

    upsertDoc(pk, doc);

    const retrieved = getDoc(pk);
    expect(retrieved).toEqual(doc);
  });

  it("should delete a doc and return whether it existed", () => {
    upsertDoc("del-1", { a: 1 });
    expect(deleteDoc("del-1")).toBe(true);
    expect(deleteDoc("del-1")).toBe(false);
    expect(getDoc("del-1")).toBeUndefined();
  });

  it("should delete docs by prefix", () => {
    upsertDoc("pfx:a", 1);
    upsertDoc("pfx:b", 2);
    upsertDoc("other:c", 3);

    expect(deleteDocsByPrefix("pfx:")).toBe(2);
    expect(getDoc("pfx:a")).toBeUndefined();
    expect(getDoc("other:c")).toEqual(3);
  });

  it("should check existence without deserializing", () => {
    upsertDoc("exists-check", { x: true });
    expect(hasDoc("exists-check")).toBe(true);
    expect(hasDoc("nope")).toBe(false);
  });

  it("should count docs by prefix", () => {
    upsertDoc("cnt:1", "a");
    upsertDoc("cnt:2", "b");
    upsertDoc("cnt:3", "c");

    expect(countByPrefix("cnt:")).toBe(3);
    expect(countByPrefix("nonexistent:")).toBe(0);
  });

  it("should list keys by prefix", () => {
    upsertDoc("keys:x", 1);
    upsertDoc("keys:y", 2);

    const keys = getKeysByPrefix("keys:");
    expect(keys).toEqual(expect.arrayContaining(["keys:x", "keys:y"]));
    expect(keys).toHaveLength(2);
  });

  it("scopes reads/deletes by the entity column", () => {
    upsertDoc("e:1", { n: 1 }, { entity: "foo" });
    upsertDoc("e:2", { n: 2 }, { entity: "foo" });
    upsertDoc("e:3", { n: 3 }, { entity: "bar" });

    expect(countByEntity("foo")).toBe(2);
    expect(getDocsByEntity("foo")).toHaveLength(2);
    expect(deleteDocsByEntity("foo")).toBe(2);
    expect(countByEntity("foo")).toBe(0);
    expect(countByEntity("bar")).toBe(1);
  });

  it("treats expired rows as absent across reads", () => {
    upsertDoc("exp:live", "a", { expiresAt: Date.now() + 60_000 });
    upsertDoc("exp:dead", "b", { expiresAt: Date.now() - 1 });

    expect(getDoc("exp:dead")).toBeUndefined();
    expect(hasDoc("exp:dead")).toBe(false);
    expect(getDoc("exp:live")).toBe("a");
    expect(countByPrefix("exp:")).toBe(1);
    expect(getKeysByPrefix("exp:")).toEqual(["exp:live"]);
  });

  it("treats LIKE metacharacters in a prefix literally", () => {
    upsertDoc("a_b:1", 1);
    upsertDoc("aXb:1", 2); // would match `a_b:%` if `_` were a wildcard

    expect(countByPrefix("a_b:")).toBe(1);
    expect(getKeysByPrefix("a_b:")).toEqual(["a_b:1"]);
    expect(deleteDocsByPrefix("a_b:")).toBe(1);
    expect(getDoc("aXb:1")).toBe(2);
  });

  it("touches expiry and physically reclaims expired rows", () => {
    upsertDoc("t:1", "x", { expiresAt: Date.now() - 1 });
    expect(touchDoc("t:1", Date.now() + 60_000)).toBe(false); // already expired

    upsertDoc("t:2", "y", { expiresAt: Date.now() + 60_000 });
    expect(touchDoc("t:2", null)).toBe(true); // clear expiry

    upsertDoc("t:3", "z", { expiresAt: Date.now() - 1 });
    expect(cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(getDoc("t:3")).toBeUndefined();
  });
});
