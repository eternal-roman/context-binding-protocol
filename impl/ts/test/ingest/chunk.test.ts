import { describe, it, expect } from "vitest";
import { chunk } from "../../src/ingest/chunk.js";

describe("chunk", () => {
  it("packs paragraphs into <= maxChars windows", () => {
    const doc = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
    const { chunks, truncated } = chunk(doc, 100, 8);
    expect(chunks.length).toBe(2);            // 40+40 fit in 100; 3rd starts a new window
    expect(chunks[0]?.length).toBeLessThanOrEqual(100);
    expect(truncated).toBe(false);
  });
  it("flags truncation and caps at maxChunks", () => {
    const doc = Array.from({ length: 12 }, (_, i) => `p${i}`.repeat(30)).join("\n\n");
    const { chunks, truncated } = chunk(doc, 60, 4);
    expect(chunks.length).toBe(4);
    expect(truncated).toBe(true);
  });
  it("ignores blank paragraphs", () => {
    const { chunks } = chunk("one\n\n\n\n   \n\ntwo", 1000, 8);
    expect(chunks).toEqual(["one\n\ntwo"]);
  });
  it("returns empty output for an empty document", () => {
    expect(chunk("", 1000, 8)).toEqual({ chunks: [], truncated: false });
  });
  it("emits a single chunk for a doc with no blank-line separators", () => {
    const { chunks, truncated } = chunk("one long paragraph without any separator", 1000, 8);
    expect(chunks).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});
