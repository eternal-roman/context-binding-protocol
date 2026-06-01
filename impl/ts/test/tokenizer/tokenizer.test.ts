import { describe, it, expect } from "vitest";
import {
  getTokenizer,
  listTokenizers,
  o200kTokenizer,
  lengthFallbackTokenizer,
} from "../../src/tokenizer/index.js";

describe("Tokenizer (G4)", () => {
  describe("registry", () => {
    it("has o200k_base registered", () => {
      expect(listTokenizers()).toContain("o200k_base");
    });

    it("has length_fallback registered", () => {
      expect(listTokenizers()).toContain("length_fallback");
    });

    it("retrieves o200k_base by name", () => {
      const t = getTokenizer("o200k_base");
      expect(t.name).toBe("o200k_base");
    });

    it("throws on unknown tokenizer", () => {
      expect(() => getTokenizer("nonexistent")).toThrow("Unknown tokenizer");
    });
  });

  describe("o200k_base", () => {
    it("counts tokens for a simple string", () => {
      const count = o200kTokenizer.countTokens("Hello, world!");
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(10);
    });

    it("counts tokens for an empty string", () => {
      expect(o200kTokenizer.countTokens("")).toBe(0);
    });

    it("counts tokens for a CBP JSON payload", () => {
      const payload = JSON.stringify({
        id: "a7c3f1e2",
        type: "entity",
        val: "BTC",
        w: 0.9,
        tags: ["domain:trading"],
      });
      const count = o200kTokenizer.countTokens(payload);
      // A typical small JSON object should be ~20-40 tokens
      expect(count).toBeGreaterThan(10);
      expect(count).toBeLessThan(60);
    });

    it("is deterministic", () => {
      const text = "Consistent token counting is essential for budget enforcement.";
      const count1 = o200kTokenizer.countTokens(text);
      const count2 = o200kTokenizer.countTokens(text);
      expect(count1).toBe(count2);
    });
  });

  describe("length_fallback", () => {
    it("estimates tokens as ceil(length / 4)", () => {
      expect(lengthFallbackTokenizer.countTokens("12345678")).toBe(2); // 8/4 = 2
      expect(lengthFallbackTokenizer.countTokens("123456789")).toBe(3); // ceil(9/4) = 3
    });

    it("returns 0 for empty string", () => {
      expect(lengthFallbackTokenizer.countTokens("")).toBe(0);
    });

    it("is marked as approximate", () => {
      expect(lengthFallbackTokenizer.name).toBe("length_fallback");
    });
  });
});
