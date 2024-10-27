import { beforeAll, describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import { clearDocstore } from "./docstore.js";
import { Entity } from "./entities.js";

interface Doc {
  id: string;
  name: string;
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

    const doc: Doc = { id: "hi", name: "hello" };
    DocEntity.upsert(doc);
    const getResult2 = DocEntity.get(doc);
    expect(getResult2).toEqual(doc);
  });
});
