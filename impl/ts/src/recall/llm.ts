export interface LlmCompletionRequest { system?: string; context: string; query: string }
export interface LlmCompletionResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface LlmClient {
  readonly modelId: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/**
 * Dependency-free default. Returns the assembled context + query verbatim,
 * labeled as an echo — for tests and "show me exactly what you would send."
 * An honest passthrough, NOT a fake reasoner (cf. HashingEmbedder).
 */
export class EchoLlmClient implements LlmClient {
  readonly modelId = "echo-v1";
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const text =
      `[echo:${this.modelId}] No model configured — returning the assembled context verbatim.\n\n` +
      `QUERY: ${req.query}\n\n${req.context}`;
    return { text };
  }
}

export interface OpenAiCompatConfig {
  baseUrl: string;            // e.g. https://api.x.ai/v1 or https://api.openai.com/v1
  model: string;
  apiKeyEnv: string;          // env var NAME holding the key — never the key itself
  maxTokens?: number;
  timeoutMs?: number;         // request timeout (default 30000) — bounds a hung/slow endpoint
}

/**
 * Real adapter over any OpenAI-compatible /chat/completions endpoint (xAI/Grok,
 * OpenAI). fetch-based — ZERO new dependencies.
 * The API key is read from process.env[apiKeyEnv] at call time and is never
 * stored on the instance or returned. (Thrown errors include the provider's
 * response body, which is provider-controlled — callers should not log secrets.)
 */
export class OpenAiCompatLlmClient implements LlmClient {
  readonly modelId: string;
  constructor(private readonly cfg: OpenAiCompatConfig) { this.modelId = `openai_compat:${cfg.model}`; }
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const key = process.env[this.cfg.apiKeyEnv];
    if (!key) throw new Error(`LLM key env var "${this.cfg.apiKeyEnv}" is not set`);
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: `${req.context}\n\nQuestion: ${req.query}` },
    ];
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.cfg.model, messages, max_tokens: this.cfg.maxTokens ?? 1024 }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      // Truncate the provider body so a large/hostile error response can't bloat
      // the thrown message. The key lives only in the Authorization header — it
      // is never in the request or response body, so it cannot leak here.
      const body = (await res.text()).slice(0, 500);
      throw new Error(`LLM API error (${res.status}): ${body}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = data.usage;
    const usage =
      u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)
        ? { inputTokens: u.prompt_tokens as number, outputTokens: u.completion_tokens as number }
        : undefined;
    return { text: data.choices?.[0]?.message?.content ?? "", usage };
  }
}
