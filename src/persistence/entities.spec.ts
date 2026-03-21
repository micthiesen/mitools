import { beforeAll, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import { clearDocstore } from "./docstore.js";
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
beforeAll(() => clearDocstore());

describe("entities", () => {
  it("should get and upsert entities", () => {
    const pk = DocEntity.getPk({ id: "hi" });
    expect(pk).toEqual("$doc#hi");

    const getResult1 = DocEntity.get({ id: "hi" });
    expect(getResult1).toBeUndefined();

    const doc: Doc = { id: "hi", name: "hello", score: 10 };
    DocEntity.upsert(doc);
    const getResult2 = DocEntity.get(doc);
    expect(getResult2).toEqual(doc);
  });

  it("should delete a single entity", () => {
    DocEntity.upsert({ id: "del", name: "gone", score: 0 });
    expect(DocEntity.delete({ id: "del" })).toBe(true);
    expect(DocEntity.delete({ id: "del" })).toBe(false);
    expect(DocEntity.get({ id: "del" })).toBeUndefined();
  });

  it("should delete all entities of a type", () => {
    DocEntity.deleteAll();
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
    DocEntity.deleteAll();
    DocEntity.upsert({ id: "c1", name: "C1", score: 1 });
    DocEntity.upsert({ id: "c2", name: "C2", score: 2 });
    DocEntity.upsert({ id: "c3", name: "C3", score: 3 });
    expect(DocEntity.count()).toBe(3);
  });

  it("should patch an entity", () => {
    DocEntity.upsert({ id: "p", name: "original", score: 0 });

    const patched = DocEntity.patch({ id: "p" }, { name: "updated" });
    expect(patched).toEqual({ id: "p", name: "updated", score: 0 });

    const fetched = DocEntity.get({ id: "p" });
    expect(fetched).toEqual({ id: "p", name: "updated", score: 0 });
  });

  it("should return undefined when patching a nonexistent entity", () => {
    expect(DocEntity.patch({ id: "ghost" }, { name: "nope" })).toBeUndefined();
  });

  it("should list keys", () => {
    DocEntity.deleteAll();
    DocEntity.upsert({ id: "k1", name: "K1", score: 1 });
    DocEntity.upsert({ id: "k2", name: "K2", score: 2 });

    const keys = DocEntity.keys();
    expect(keys).toEqual(expect.arrayContaining(["$doc#k1", "$doc#k2"]));
    expect(keys).toHaveLength(2);
  });
});
