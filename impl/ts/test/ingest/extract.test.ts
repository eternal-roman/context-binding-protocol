import { describe, it, expect, vi } from "vitest";
import { LlmExtractor } from "../../src/ingest/extract.js";
import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../../src/recall/llm.js";

class ScriptedLlm implements LlmClient {
  readonly modelId = "scripted";
  constructor(private readonly perCall: Array<string | Error>) {}
  private i = 0;
  async complete(_req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const next = this.perCall[this.i++];
    if (next instanceof Error) throw next;
    return { text: next ?? "[]" };
  }
}

describe("LlmExtractor", () => {
  it("parses facts (fence-tolerant) and dedups across chunks by normalized val", async () => {
    const doc = ["para one".repeat(10), "para two".repeat(10)].join("\n\n");
    const llm = new ScriptedLlm([
      '```json\n[{"type":"state","val":"BTC is up","w":0.9}]\n```',
      '[{"type":"state","val":"btc is up"},{"type":"prior","val":"Do not deploy Fridays","tags":["policy"]}]',
    ]);
    const out = await new LlmExtractor(llm, { maxChars: 50, maxChunks: 8 }).extract(doc);
    expect(out.facts.map((f) => f.val)).toEqual(["BTC is up", "Do not deploy Fridays"]); // dup "btc is up" dropped
    expect(out.stats.failedChunks).toBe(0);
  });
  it("skips a failed chunk without aborting the run", async () => {
    const doc = ["alpha".repeat(20), "beta".repeat(20)].join("\n\n");
    const llm = new ScriptedLlm([new Error("boom"), '[{"type":"entity","val":"Northwind"}]']);
    const out = await new LlmExtractor(llm, { maxChars: 60, maxChunks: 8, onChunkError: (): void => {} }).extract(doc);
    expect(out.facts.map((f) => f.val)).toEqual(["Northwind"]);
    expect(out.stats.failedChunks).toBe(1);
  });
  it("counts a malformed (non-JSON) chunk response as a failed chunk", async () => {
    const doc = "only one paragraph here";
    const llm = new ScriptedLlm(["sorry, I cannot do that"]); // not JSON, no array
    const out = await new LlmExtractor(llm, { onChunkError: (): void => {} }).extract(doc);
    expect(out.facts).toHaveLength(0);
    expect(out.stats.failedChunks).toBe(1);
  });
  it("invokes onChunkError with the error for a failed chunk", async () => {
    const errors: unknown[] = [];
    const llm = new ScriptedLlm([new Error("boom")]);
    const out = await new LlmExtractor(llm, { onChunkError: (e): void => { errors.push(e); } }).extract("single paragraph doc");
    expect(out.stats.failedChunks).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
  it("drops a fact whose val is an empty string", async () => {
    const llm = new ScriptedLlm(['[{"type":"state","val":""},{"type":"state","val":"real fact"}]']);
    const out = await new LlmExtractor(llm).extract("doc");
    expect(out.facts.map((f) => f.val)).toEqual(["real fact"]);
  });
  it("default chunk-error log emits only safe metadata, never the error message (no content leak)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation((): void => {});
    try {
      const llm = new ScriptedLlm([new Error("SECRET_DOC_CONTENT must never reach the log")]);
      await new LlmExtractor(llm).extract("a single paragraph doc"); // no custom handler → default fires
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0];
      if (!call) throw new Error("console.error was not called");
      const logged = call.join(" ");
      expect(logged).toContain("chunk 1");
      expect(logged).toContain("Error");                 // error CLASS name is safe to log
      expect(logged).not.toContain("SECRET_DOC_CONTENT"); // err.message content must NOT be logged
    } finally {
      spy.mockRestore();
    }
  });
});
