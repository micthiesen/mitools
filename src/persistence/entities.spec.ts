import { describe, it } from "vitest";
import { Entity } from "./entities.js";

interface Doc {
  id: string;
  name: string;
}

describe("entities", () => {
  it("should handle PK function properly", () => {
    const Doc = new Entity("Doc", (arg: Pick<Doc, "id">) => "hi");
    Doc.getPk({ id: "hi" });

    const doc: Doc = { id: "hi", name: "hello" };
    Doc.upsert(doc);
    Doc.get(doc);
  });
});
