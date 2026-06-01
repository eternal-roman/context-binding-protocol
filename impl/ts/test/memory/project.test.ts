import { describe, it, expect } from "vitest";
import { projectNode, projectFrameNodes } from "../../src/memory/project.js";
import { MemoryRecord } from "../../src/memory/types.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { ResolvedNode } from "../../src/types/node.js";

const tokenizer = getTokenizer("length_fallback");
const node = (over: Partial<ResolvedNode> = {}): ResolvedNode => ({
  id: "a7c3f1e2", type: "state", val: "BTC up", lineage: "f0d2e8a1", tags: ["domain:trading"],
  v: 1, prev: null, w: 0.7, decay: "none", ttl: null, ...over,
});

describe("projectNode", () => {
  it("produces a schema-valid MemoryRecord carrying w/lineage/tags from the node", async () => {
    const rec = await projectNode(node(), { tokenizer });
    expect(() => MemoryRecord.parse(rec)).not.toThrow();
    expect(rec.w).toBe(0.7);
    expect(rec.lineage).toBe("f0d2e8a1");
    expect(rec.embedding).toBeNull();
    expect(rec.embeddingModel).toBeNull();
  });
  it("embeds the Full fidelity and pins the model id when an embedder is given", async () => {
    const rec = await projectNode(node(), { tokenizer, embedder: new HashingEmbedder(64) });
    expect(rec.embedding).toHaveLength(64);
    expect(rec.embeddingModel).toBe("hashing-v1@64");
  });
  it("clamps an out-of-range w into [0,1] (defensive — graph insert is unvalidated upstream)", async () => {
    const high = await projectNode(node({ w: 5 }), { tokenizer });
    expect(high.w).toBe(1);
    const low = await projectNode(node({ w: -2 }), { tokenizer });
    expect(low.w).toBe(0);
  });
});

describe("projectFrameNodes", () => {
  it("excludes frame-anchor nodes (type === 'frame') — they are not memories", async () => {
    const recs = await projectFrameNodes(
      [node({ id: "aaaaaaaa", type: "frame" }), node({ id: "bbbbbbbb", type: "state" })],
      { tokenizer }
    );
    expect(recs.map((r) => r.id)).toEqual(["bbbbbbbb"]);
  });
});
