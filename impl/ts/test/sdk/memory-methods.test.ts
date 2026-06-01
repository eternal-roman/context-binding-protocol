import { describe, it, expect } from "vitest";
import { CbpClient } from "../../src/sdk/client.js";
import type { FrameConfig } from "../../src/types/frame.js";
import "../../src/tokenizer/index.js";

const frameConfig: FrameConfig = {
  id: "sdk_mem", domain_tags: ["domain:test"], root_weight: 1, root_decay: "none",
  refresh_policy: "on_demand", max_token_budget: 4000, inheritance_mode: "prototypal",
  conditional_edge_eval: "eager", tokenizer: "o200k_base", acl_tags: [],
};

describe("CbpClient memory methods", () => {
  it("ingests facts and recalls them scoped to its own frame", async () => {
    const c = new CbpClient({ frameConfig, writeAccess: true });
    await c.ingest([
      { type: "state", val: "BTC price climbing", tags: ["live"], w: 0.9 },
      { type: "prior", val: "Do not deploy on Fridays", tags: ["policy"], w: 0.8 },
    ]);
    const ctx = await c.recall("bitcoin price");
    expect(ctx.entries.length).toBeGreaterThan(0);
    expect(ctx.entries.some((e) => e.text.includes("BTC price"))).toBe(true);
    expect(ctx.tokensUsed).toBeLessThanOrEqual(frameConfig.max_token_budget);
  });
  it("ask returns the grounded context via the default Echo client", async () => {
    const c = new CbpClient({ frameConfig, writeAccess: true });
    await c.ingest([{ type: "state", val: "BTC price climbing", w: 0.9, tags: [] }]);
    const out = await c.ask("bitcoin price");
    expect(out.answer).toContain(out.context.block);
  });
  it("recall on an empty store yields an empty block", async () => {
    const c = new CbpClient({ frameConfig });
    const ctx = await c.recall("anything");
    expect(ctx.entries).toHaveLength(0);
    expect(ctx.block).toBe("");
  });
  it("ingest throws without writeAccess (read-only client, consistent with upsert/recordPrior)", async () => {
    const c = new CbpClient({ frameConfig }); // no writeAccess
    await expect(c.ingest([{ type: "state", val: "x", w: 0.6, tags: [] }])).rejects.toThrow(/write access not enabled/i);
  });
  it("clamps recall budget to the frame's max_token_budget (governance)", async () => {
    const tinyFrame: FrameConfig = { ...frameConfig, id: "tiny", max_token_budget: 25 };
    const c = new CbpClient({ frameConfig: tinyFrame, writeAccess: true });
    await c.ingest([{ type: "state", val: "a fairly long fact that easily exceeds twenty-five tokens once rendered into the context block with its header and citation marker", w: 0.9, tags: [] }]);
    const ctx = await c.recall("long fact", { budget: 999999 }); // caller requests a huge budget
    expect(ctx.tokensUsed).toBeLessThanOrEqual(25); // clamped to the frame's max — proves the clamp (unclamped would be far larger)
  });
});
