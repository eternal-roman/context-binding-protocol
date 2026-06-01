import { describe, it, expect } from "vitest";
import { MemoryConfig, LlmConfig, ServerConfig } from "../../src/types/config.js";

describe("MemoryConfig / LlmConfig", () => {
  it("MemoryConfig.parse({}) yields dep-free, key-free defaults", () => {
    const m = MemoryConfig.parse({});
    expect(m).toMatchObject({ embedder: "hashing", dim: 256, default_k: 50, recall_budget: 2000 });
    expect(m.llm.provider).toBe("echo");
  });
  it("LlmConfig accepts an openai_compat block and has no literal api_key field", () => {
    const l = LlmConfig.parse({ provider: "openai_compat", base_url: "https://api.x.ai/v1", model: "grok-4-1-fast-reasoning", api_key_env: "XAI_API_KEY" });
    expect(l.model).toBe("grok-4-1-fast-reasoning");
    expect(l.api_key_env).toBe("XAI_API_KEY"); // the env var NAME (not a secret)
    expect("api_key" in l).toBe(false);          // never the literal key
  });
  it("ServerConfig treats memory as OPTIONAL (existing configs without it still parse)", () => {
    const s = ServerConfig.parse({});
    expect(s.memory).toBeUndefined();
  });
  it("ServerConfig accepts a provided memory block and applies MemoryConfig sub-defaults", () => {
    const s = ServerConfig.parse({ memory: { dim: 384 } });
    expect(s.memory?.dim).toBe(384);
    expect(s.memory?.embedder).toBe("hashing");
    expect(s.memory?.llm.provider).toBe("echo");
  });
});
