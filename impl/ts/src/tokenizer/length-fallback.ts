/**
 * Length-based fallback tokenizer.
 *
 * Estimates token count as character_count / 4 (rounded up).
 * Used in environments where tiktoken is unavailable.
 * Marked clearly as APPROXIMATE — not suitable for exact budget enforcement.
 */

import type { Tokenizer } from "./tokenizer.js";

export const lengthFallbackTokenizer: Tokenizer = {
  name: "length_fallback",
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  },
};
