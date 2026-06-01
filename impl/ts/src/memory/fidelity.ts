import type { ResolvedNode } from "../types/node.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";
import { canonicalize } from "../wire/canonical.js";
import type { Fidelity } from "./types.js";

export type FidelityStrings = Record<Fidelity, string>;
export type FidelityCost = Record<Fidelity, number>;

export interface FidelityDeriver {
  derive(node: ResolvedNode): FidelityStrings;
}

/**
 * Deterministic, dependency-free fidelity derivation.
 *
 * Full      = the node's content (raw string, or canonical JSON for objects).
 * Signal    = a cheap fingerprint: `type:firstTag` (or `type:id` if untagged).
 * Condensed = a PLACEHOLDER deterministic shortening (sentence-boundary or hard
 *             truncation). Real semantic condensation is produced by the
 *             extraction adapter at ingest (Phase 4); this exists so the
 *             substrate is buildable and testable now without an LLM.
 */
export class DeterministicFidelityDeriver implements FidelityDeriver {
  constructor(private readonly condensedChars = 120) {}
  derive(node: ResolvedNode): FidelityStrings {
    const full = typeof node.val === "string" ? node.val : canonicalize(node.val);
    const firstTag = node.tags[0];
    const signal = `${node.type}:${firstTag ?? node.id}`;
    return { full, condensed: condense(full, this.condensedChars), signal };
  }
}

function condense(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const window = trimmed.slice(0, maxChars);
  const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const body = stop > maxChars * 0.5 ? window.slice(0, stop + 1) : window.trimEnd();
  return body + "…";
}

export function costOf(fids: FidelityStrings, tokenizer: Tokenizer): FidelityCost {
  return {
    full: tokenizer.countTokens(fids.full),
    condensed: tokenizer.countTokens(fids.condensed),
    signal: tokenizer.countTokens(fids.signal),
  };
}
