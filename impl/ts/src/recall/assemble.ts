import type { Tokenizer } from "../tokenizer/tokenizer.js";
import type { Fidelity, MemoryRecord } from "../memory/types.js";
import type { AssembledContext, AssembledEntry } from "./types.js";

const HEADER = "── Recalled context ──";
const FIDELITY_ORDER: Fidelity[] = ["full", "condensed", "signal"];

/** Render the block. Empty entry set → "" so a tiny budget never forces an over-budget header. */
function render(entries: AssembledEntry[]): string {
  if (entries.length === 0) return "";
  const body = entries.map((e) => `[${e.ref}] (${e.nodeType}) ${e.text}`).join("\n\n");
  return `${HEADER}\n\n${body}`;
}

/**
 * Pack a relevance-ranked recall set into a token budget, choosing each record's
 * highest fidelity that still fits. NOT the PNFO optimizer: no value model, no
 * redundancy term, no knapsack. Budget is counted on the RENDERED block, so the
 * invariant holds on the actual output. Dropped records are always reported.
 */
export function assembleContext(
  ranked: Array<{ rec: MemoryRecord; score: number }>,
  opts: { budget: number; tokenizer: Tokenizer; minScore?: number }
): AssembledContext {
  const minScore = opts.minScore ?? 0;
  // Budget is law: a non-finite or negative budget admits nothing and is
  // normalized to 0 so the documented invariant (tokensUsed <= budget) holds
  // for every input rather than being silently false (0 <= NaN/-100).
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : 0;
  const entries: AssembledEntry[] = [];
  const dropped: AssembledContext["dropped"] = [];

  for (const { rec, score } of ranked) {
    // A non-finite score (NaN/Infinity from a degenerate scorer) cannot
    // meaningfully clear a threshold — treat it as below minScore and drop.
    if (!Number.isFinite(score) || score < minScore) { dropped.push({ id: rec.id, reason: "min_score" }); continue; }
    let admitted = false;
    const before = opts.tokenizer.countTokens(render(entries)); // constant across the fidelity attempts below
    for (const fidelity of FIDELITY_ORDER) {
      const candidate: AssembledEntry = {
        ref: entries.length + 1, id: rec.id, nodeType: rec.nodeType,
        fidelity, score, tokens: 0, text: rec.fidelities[fidelity],
      };
      const after = opts.tokenizer.countTokens(render([...entries, candidate]));
      if (after <= budget) {
        candidate.tokens = after - before;
        entries.push(candidate);
        admitted = true;
        break;
      }
    }
    if (!admitted) dropped.push({ id: rec.id, reason: "no_fidelity_fits" });
  }

  const block = render(entries);
  return { block, entries, tokensUsed: opts.tokenizer.countTokens(block), budget, dropped };
}
