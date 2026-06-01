import type { NodeType } from "../types/node.js";
import type { Fidelity } from "../memory/types.js";

export interface AssembledEntry {
  ref: number;                 // 1-based citation marker [n]
  id: string;
  nodeType: NodeType;
  fidelity: Fidelity;
  score: number;
  tokens: number;              // rendered token delta attributable to this entry (includes header cost for the first entry)
  text: string;
}
export interface AssembledContext {
  block: string;               // prompt-ready; "" when nothing fits
  entries: AssembledEntry[];
  tokensUsed: number;          // tokens(block) — always <= budget
  budget: number;
  dropped: Array<{ id: string; reason: "min_score" | "no_fidelity_fits" }>;
}
export interface AskResult {
  answer: string;
  context: AssembledContext;
  usage?: { inputTokens: number; outputTokens: number };
}
