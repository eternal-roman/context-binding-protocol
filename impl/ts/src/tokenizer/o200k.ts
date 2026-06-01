/**
 * o200k_base tokenizer — OpenAI's tokenizer for GPT-4o and similar models.
 *
 * Uses js-tiktoken for exact token counting. This is the default tokenizer
 * for CBP frames unless overridden in the frame config.
 */

import { getEncoding } from "js-tiktoken";
import type { Tokenizer } from "./tokenizer.js";

let encoder: ReturnType<typeof getEncoding> | null = null;

function getEncoder(): ReturnType<typeof getEncoding> {
  if (!encoder) {
    encoder = getEncoding("o200k_base");
  }
  return encoder;
}

export const o200kTokenizer: Tokenizer = {
  name: "o200k_base",
  countTokens(text: string): number {
    return getEncoder().encode(text).length;
  },
};
