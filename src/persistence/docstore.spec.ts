import { describe, expect, it } from "vitest";
import { Injector } from "../config/Injector.js";
import { LogLevel } from "../logging/types.js";
import { getDoc, upsertDoc } from "./docstore.js";

Injector.configure({
  config: {
    LOG_LEVEL: LogLevel.DEBUG,
    PUSHOVER_TOKEN: "fake-token",
    PUSHOVER_USER: "fake-user",
  },
});

describe("docstore", () => {
  it("should store and retrieve a blob", () => {
    const pk = "test-pk";
    const doc = { foo: "bar", date: new Date("2020-01-01") };

    upsertDoc(pk, doc);

    const retrieved = getDoc(pk);
    expect(retrieved).toEqual(doc);
  });
});
