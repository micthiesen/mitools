import { beforeAll, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import {
  clearDocstore,
  countByPrefix,
  deleteDoc,
  deleteDocsByPrefix,
  getDoc,
  getKeysByPrefix,
  hasDoc,
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
});
