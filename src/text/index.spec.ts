import { describe, expect, it } from "vitest";
import { splitTextIntoChunks, splitTextIntoEqualParts } from "./index.js";

describe("splitTextIntoChunks", () => {
  it("should return an empty array when the input text is empty", () => {
    const result = splitTextIntoChunks("", 100);
    expect(result).toMatchInlineSnapshot("[]");
  });

  it("should return a single chunk when the text is smaller than maxLength", () => {
    const text = "This is a short sentence.";
    const result = splitTextIntoChunks(text, 100);
    expect(result).toMatchInlineSnapshot(`
      [
        "This is a short sentence.",
      ]
    `);
  });

  it("should split text into sentences without exceeding the chunk size", () => {
    const text = "Sentence one. Sentence two. Sentence three.";
    const result = splitTextIntoChunks(text, 25);
    expect(result).toMatchInlineSnapshot(`
      [
        "Sentence one.",
        "Sentence two.",
        "Sentence three.",
      ]
    `);
  });

  it("should start a new chunk when adding a sentence exceeds chunk size", () => {
    const text = "This is a sentence. Another sentence that is longer.";
    const result = splitTextIntoChunks(text, 30);
    expect(result).toMatchInlineSnapshot(`
      [
        "This is a sentence.",
        "Another sentence that is longer.",
      ]
    `);
  });

  it("should trim and collapse whitespace", () => {
    const text = "   Leading and trailing spaces.   Another sentence.  ";
    const result = splitTextIntoChunks(text, 50);
    expect(result).toMatchInlineSnapshot(`
      [
        "Leading and trailing spaces. Another sentence.",
      ]
    `);
  });

  it("should prefer paragraph boundaries over sentence boundaries", () => {
    const text =
      "First paragraph with multiple sentences. It continues here.\n\nSecond paragraph is short.";
    const result = splitTextIntoChunks(text, 200);
    expect(result).toMatchInlineSnapshot(`
      [
        "First paragraph with multiple sentences. It continues here.

      Second paragraph is short.",
      ]
    `);
  });

  it("should split paragraphs into separate chunks when they exceed maxLength", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const result = splitTextIntoChunks(text, 30);
    expect(result).toMatchInlineSnapshot(`
      [
        "First paragraph.",
        "Second paragraph.",
        "Third paragraph.",
      ]
    `);
  });

  it("should fall back to sentence splitting for oversized paragraphs", () => {
    const text =
      "Short paragraph.\n\nThis is a very long paragraph. It has many sentences. They keep going and going. Eventually it must be split by sentences.";
    const result = splitTextIntoChunks(text, 60);
    expect(result).toMatchInlineSnapshot(`
      [
        "Short paragraph.",
        "This is a very long paragraph. It has many sentences.",
        "They keep going and going.",
        "Eventually it must be split by sentences.",
      ]
    `);
  });
});

describe("splitTextIntoEqualParts", () => {
  it("returns the original text when n <= 1", () => {
    const text = "Some text here.";
    expect(splitTextIntoEqualParts(text, 1)).toEqual(["Some text here."]);
    expect(splitTextIntoEqualParts(text, 0)).toEqual(["Some text here."]);
  });

  it("splits four sentences into two roughly equal halves", () => {
    const text =
      "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.";
    const result = splitTextIntoEqualParts(text, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("First sentence here. Second sentence here.");
    expect(result[1]).toBe("Third sentence here. Fourth sentence here.");
  });

  it("returns single part for single-sentence text", () => {
    const text = "Just one long sentence without any breaks at all";
    const result = splitTextIntoEqualParts(text, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("splits into three parts", () => {
    const text =
      "One sentence. Two sentence. Three sentence. Four sentence. Five sentence. Six sentence.";
    const result = splitTextIntoEqualParts(text, 3);
    expect(result).toHaveLength(3);
    const rejoined = result.join(" ");
    expect(rejoined).toContain("One sentence.");
    expect(rejoined).toContain("Six sentence.");
  });

  it("respects abbreviations when splitting", () => {
    const text =
      "Dr. Smith went to the store. Mrs. Jones followed him. They bought supplies. Then they left.";
    const result = splitTextIntoEqualParts(text, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Dr. Smith");
    expect(result.join(" ")).toBe(text);
  });

  it("never returns more parts than sentences", () => {
    const text = "Only two sentences. Here they are.";
    const result = splitTextIntoEqualParts(text, 5);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
