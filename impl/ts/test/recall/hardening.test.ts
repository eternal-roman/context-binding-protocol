import { describe, it, expect, vi, afterEach } from "vitest";
import { assembleContext } from "../../src/recall/assemble.js";
import { OpenAiCompatLlmClient } from "../../src/recall/llm.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { MemoryRecord } from "../../src/memory/types.js";

const tok = getTokenizer("length_fallback");
function rec(id: string, full = "this is a recalled fact about the topic"): MemoryRecord {
  return {
    id, nodeType: "state",
    fidelities: { full, condensed: full.slice(0, 10), signal: "s" },
    tokenCost: { full: tok.countTokens(full), condensed: tok.countTokens(full.slice(0, 10)), signal: tok.countTokens("s") },
    embedding: null, embeddingModel: null, tags: [], lineage: null, w: 1,
  };
}

describe("assembleContext — budget invariant holds for degenerate inputs", () => {
  for (const bad of [NaN, -100, Infinity, -Infinity] as number[]) {
    it(`normalizes budget=${bad} to 0 so tokensUsed <= budget holds`, () => {
      const out = assembleContext([{ rec: rec("a"), score: 0.9 }], { budget: bad, tokenizer: tok });
      expect(out.budget).toBe(0);
      expect(out.tokensUsed).toBe(0);
      expect(out.block).toBe("");
      expect(out.tokensUsed).toBeLessThanOrEqual(out.budget);
      expect(out.dropped).toContainEqual({ id: "a", reason: "no_fidelity_fits" });
    });
  }

  it("drops a record whose score is non-finite (NaN) rather than admitting NaN into entries", () => {
    const out = assembleContext([{ rec: rec("a"), score: NaN }, { rec: rec("b"), score: 0.9 }], { budget: 1000, tokenizer: tok });
    expect(out.entries.map((e) => e.id)).toEqual(["b"]);
    expect(out.dropped).toContainEqual({ id: "a", reason: "min_score" });
    expect(out.entries.every((e) => Number.isFinite(e.score))).toBe(true);
  });
});

describe("OpenAiCompatLlmClient — robustness", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("omits usage when the provider returns partial/malformed usage", async () => {
    vi.stubEnv("K", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const c = new OpenAiCompatLlmClient({ baseUrl: "https://x/v1", model: "m", apiKeyEnv: "K" });
    const out = await c.complete({ context: "c", query: "q" });
    expect(out.text).toBe("hi");
    expect(out.usage).toBeUndefined(); // not { inputTokens: undefined, outputTokens: undefined }
  });

  it("never leaks the API key value into a non-2xx error message", async () => {
    vi.stubEnv("K", "sk-supersecret-value");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream exploded", { status: 500 })));
    const c = new OpenAiCompatLlmClient({ baseUrl: "https://x/v1", model: "m", apiKeyEnv: "K" });
    const err = await c.complete({ context: "c", query: "q" }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = err instanceof Error ? err.message : "";
    expect(msg).toMatch(/500/);
    expect(msg).not.toContain("sk-supersecret-value");
  });
});
