const ABBREVIATION_RE =
  /(?<=[.!?])(?<!Mr\.|Ms\.|Mrs\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.|St\.|Inc\.|Corp\.|Co\.|Ltd\.|U\.S\.|U\.K\.|i\.e\.|e\.g\.|etc\.|vs\.|Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sep\.|Sept\.|Oct\.|Nov\.|Dec\.)\s+(?=[A-Z])/g;

/** Split a paragraph into sentences, respecting common abbreviations. */
export function splitIntoSentences(text: string): string[] {
  return text
    .split(ABBREVIATION_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize raw text into cleaned paragraphs. */
export function toParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * Splits text into chunks no larger than `maxLength`.
 *
 * Prefers paragraph boundaries so each chunk preserves natural pauses.
 * When a single paragraph exceeds `maxLength`, falls back to sentence-level splitting.
 */
export function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const paragraphs = toParagraphs(text);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const separator = current ? "\n\n" : "";

    if (current.length + separator.length + paragraph.length <= maxLength) {
      current += separator + paragraph;
    } else if (paragraph.length <= maxLength) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      if (current) chunks.push(current);
      current = "";

      for (const sentence of splitIntoSentences(paragraph)) {
        const sep = current ? " " : "";
        if (current.length + sep.length + sentence.length <= maxLength) {
          current += sep + sentence;
        } else {
          if (current) chunks.push(current);
          current = sentence;
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Split text into roughly `n` equal parts, breaking at sentence or paragraph boundaries.
 */
export function splitTextIntoEqualParts(text: string, n: number): string[] {
  if (n <= 1) return [text];

  const sentences: { text: string; len: number }[] = [];
  for (const para of toParagraphs(text)) {
    for (const s of splitIntoSentences(para)) {
      sentences.push({ text: s, len: s.length });
    }
  }

  if (sentences.length <= 1) return [text];

  const totalLen = sentences.reduce((sum, s) => sum + s.len, 0);
  const targetLen = totalLen / n;

  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const sentence of sentences) {
    const wouldExceed = currentLen + sentence.len > targetLen * 1.15;
    if (wouldExceed && current.length > 0 && parts.length < n - 1) {
      parts.push(current.join(" "));
      current = [];
      currentLen = 0;
    }

    current.push(sentence.text);
    currentLen += sentence.len;
  }

  if (current.length > 0) parts.push(current.join(" "));
  return parts;
}
