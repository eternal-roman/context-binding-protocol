import { describe, it, expect } from "vitest";
import { RecallPipeline } from "../../src/recall/pipeline.js";
import { InMemoryMemoryStore, projectNode } from "../../src/memory/index.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import { EchoLlmClient } from "../../src/recall/llm.js";
import type { ResolvedNode } from "../../src/types/node.js";

const tok = getTokenizer("length_fallback");
const node = (id: string, val: string, tags: string[]): ResolvedNode =>
  ({ id, type: "state", val, lineage: null, tags, v: 1, prev: null, w: 0.8, decay: "none", ttl: null });

async function seeded(): Promise<RecallPipeline> {
  const embedder = new HashingEmbedder(256);
  const memory = new InMemoryMemoryStore();
  await memory.upsert(await projectNode(node("aaaaaaaa", "bitcoin price climbing fast", ["frame:trade"]), { tokenizer: tok, embedder }));
  await memory.upsert(await projectNode(node("bbbbbbbb", "patient blood pressure vitals", ["frame:trade"]), { tokenizer: tok, embedder }));
  await memory.upsert(await projectNode(node("cccccccc", "bitcoin rally continues", ["frame:other"]), { tokenizer: tok, embedder }));
  return new RecallPipeline({ embedder, memory, llm: new EchoLlmClient() });
}

describe("RecallPipeline", () => {
  it("recall scopes by scopeTags and ranks by relevance within scope", async () => {
    const p = await seeded();
    const ctx = await p.recall("bitcoin price rising", { scopeTags: ["frame:trade"], budget: 1000, tokenizer: tok });
    expect(ctx.entries[0]?.id).toBe("aaaaaaaa");        // best in-scope match
    expect(ctx.entries.map((e) => e.id)).not.toContain("cccccccc"); // out of scope, excluded
    expect(ctx.tokensUsed).toBeLessThanOrEqual(1000);
  });
  it("ask runs recall then the LlmClient, returning answer + context", async () => {
    const p = await seeded();
    const out = await p.ask("bitcoin price rising", { scopeTags: ["frame:trade"], budget: 1000, tokenizer: tok });
    expect(out.context.entries.length).toBeGreaterThan(0);
    expect(out.answer).toContain(out.context.block);   // Echo returns the block
  });
  it("recall throws when scopeTags is empty (fail-closed: no all-frames recall)", async () => {
    const p = await seeded();
    await expect(p.recall("anything", { scopeTags: [], budget: 1000, tokenizer: tok }))
      .rejects.toThrow(/scopeTags/);
  });
  it("filterTags AND-narrows within scope (a tag no in-scope record has yields empty)", async () => {
    const p = await seeded();
    const ctx = await p.recall("bitcoin price rising", { scopeTags: ["frame:trade"], filterTags: ["nonexistent"], budget: 1000, tokenizer: tok });
    expect(ctx.entries).toHaveLength(0);
  });
  it("ask throws when no LlmClient is configured", async () => {
    const p = new RecallPipeline({ embedder: new HashingEmbedder(256), memory: new InMemoryMemoryStore() });
    await expect(p.ask("q", { scopeTags: ["frame:x"], budget: 100, tokenizer: tok }))
      .rejects.toThrow(/no LlmClient/i);
  });
});
