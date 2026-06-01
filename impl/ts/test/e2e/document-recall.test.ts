import { describe, it, expect } from "vitest";
import { CbpClient } from "../../src/sdk/client.js";
import type { LlmClient } from "../../src/recall/llm.js";
import type { FrameConfig } from "../../src/types/frame.js";
import "../../src/tokenizer/index.js";

/** Scripted extractor LLM: returns two facts as a JSON array regardless of input. */
class DocLlm implements LlmClient {
  readonly modelId = "doc-scripted";
  async complete(): Promise<{ text: string }> {
    return {
      text: JSON.stringify([
        { type: "prior", val: "Do not deploy on Fridays", tags: ["policy"], w: 0.9 },
        { type: "entity", val: "Priya Nair is the on-call lead", tags: ["people"], w: 0.8 },
      ]),
    };
  }
}
const frame = (id: string): FrameConfig => ({
  id, domain_tags: ["ops"], root_weight: 1, root_decay: "none", refresh_policy: "on_demand",
  max_token_budget: 4000, inheritance_mode: "prototypal", conditional_edge_eval: "eager",
  tokenizer: "o200k_base", acl_tags: [],
});

describe("e2e: document → ingest → recall → ask", () => {
  it("ingests a document via a scripted extractor and recalls the right fact under budget", async () => {
    const c = new CbpClient({ frameConfig: frame("ops"), writeAccess: true, llmClient: new DocLlm() });
    const r = await c.ingestDocument("Ops runbook.\n\nNo Friday deploys. Priya is on call.");
    expect(r.ingested).toBe(2);                      // both scripted facts ingested
    const ctx = await c.recall("who is on call for incidents?");
    expect(ctx.tokensUsed).toBeLessThanOrEqual(4000); // budget invariant
    expect(ctx.block).toContain("Priya");             // the relevant fact is recalled
  });

  it("ask grounds the answer on the recalled context (Echo default)", async () => {
    const c = new CbpClient({ frameConfig: frame("ops2"), writeAccess: true }); // default EchoLlmClient
    await c.ingest([{ type: "entity", val: "Priya Nair is the on-call lead", w: 0.9, tags: [] }]);
    const out = await c.ask("who is on call?");
    expect(out.context.block).toContain("Priya");
    expect(out.answer).toContain(out.context.block);  // Echo returns the assembled block verbatim
  });

  it("two independent SDK clients do not share memory (per-client isolation)", async () => {
    const a = new CbpClient({ frameConfig: frame("fa"), writeAccess: true });
    const b = new CbpClient({ frameConfig: frame("fb"), writeAccess: true });
    await a.ingest([{ type: "state", val: "ALPHA SECRET trading signal", w: 0.6, tags: [] }]);
    await b.ingest([{ type: "state", val: "beta clinical note about vitals", w: 0.6, tags: [] }]);
    const fromB = await b.recall("ALPHA SECRET trading signal");
    expect(fromB.block).not.toContain("ALPHA SECRET"); // a's fact never appears in b's recall
  });
});
