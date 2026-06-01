import { describe, it, expect, vi, afterEach } from "vitest";
import { EchoLlmClient, OpenAiCompatLlmClient } from "../../src/recall/llm.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("EchoLlmClient", () => {
  it("echoes the assembled context + query deterministically, labeled", async () => {
    const c = new EchoLlmClient();
    const r1 = await c.complete({ context: "CTX", query: "Q" });
    const r2 = await c.complete({ context: "CTX", query: "Q" });
    expect(r1.text).toBe(r2.text);
    expect(r1.text).toContain("CTX");
    expect(r1.text).toContain("Q");
    expect(r1.text.toLowerCase()).toContain("echo");
  });
});

describe("OpenAiCompatLlmClient", () => {
  it("POSTs an OpenAI-compatible chat body and parses the answer + usage", async () => {
    vi.stubEnv("TEST_LLM_KEY", "sekret");
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "the answer" } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const c = new OpenAiCompatLlmClient({ baseUrl: "https://api.example.com/v1", model: "m-1", apiKeyEnv: "TEST_LLM_KEY" });
    const out = await c.complete({ system: "sys", context: "CTX", query: "Q" });

    expect(out.text).toBe("the answer");
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sekret");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("m-1");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1].content).toContain("CTX");
    expect(body.messages[1].content).toContain("Q");
  });

  it("throws a clear error when the key env var is unset (never logs a key)", async () => {
    const c = new OpenAiCompatLlmClient({ baseUrl: "https://x/v1", model: "m", apiKeyEnv: "DEFINITELY_UNSET_KEY" });
    await expect(c.complete({ context: "c", query: "q" })).rejects.toThrow(/DEFINITELY_UNSET_KEY/);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubEnv("TEST_LLM_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const c = new OpenAiCompatLlmClient({ baseUrl: "https://x/v1", model: "m", apiKeyEnv: "TEST_LLM_KEY" });
    await expect(c.complete({ context: "c", query: "q" })).rejects.toThrow(/500/);
  });

  it("leaves usage undefined when the API omits it", async () => {
    vi.stubEnv("TEST_LLM_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const c = new OpenAiCompatLlmClient({ baseUrl: "https://x/v1", model: "m", apiKeyEnv: "TEST_LLM_KEY" });
    const out = await c.complete({ context: "c", query: "q" });
    expect(out.usage).toBeUndefined();
  });
});
