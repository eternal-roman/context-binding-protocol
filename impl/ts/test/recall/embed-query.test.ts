import { describe, it, expect } from "vitest";
import { RecallPipeline } from "../../src/recall/pipeline.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { Embedder } from "../../src/memory/embedder.js";

const tok = getTokenizer("length_fallback");

describe("RecallPipeline query embedding", () => {
  it("uses embedQuery when the embedder provides one (asymmetric models)", async () => {
    const calls: string[] = [];
    const embedder: Embedder = {
      modelId: "spy", dim: 4,
      async embed(t) { calls.push(`embed:${t}`); return [1, 0, 0, 0]; },
      async embedQuery(t) { calls.push(`embedQuery:${t}`); return [0, 1, 0, 0]; },
    };
    const p = new RecallPipeline({ embedder, memory: new InMemoryMemoryStore() });
    await p.recall("hello", { scopeTags: ["frame:x"], budget: 1000, tokenizer: tok });
    expect(calls).toContain("embedQuery:hello");
    expect(calls).not.toContain("embed:hello");
  });

  it("falls back to embed when the embedder has no embedQuery (symmetric default)", async () => {
    const calls: string[] = [];
    const embedder: Embedder = {
      modelId: "spy2", dim: 4,
      async embed(t) { calls.push(`embed:${t}`); return [1, 0, 0, 0]; },
    };
    const p = new RecallPipeline({ embedder, memory: new InMemoryMemoryStore() });
    await p.recall("hi", { scopeTags: ["frame:x"], budget: 1000, tokenizer: tok });
    expect(calls).toContain("embed:hi");
  });
});
