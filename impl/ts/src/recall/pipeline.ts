import type { Embedder } from "../memory/embedder.js";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryRecord } from "../memory/types.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";
import type { LlmClient } from "./llm.js";
import type { Retriever } from "./retriever.js";
import type { AssembledContext, AskResult } from "./types.js";
import { assembleContext } from "./assemble.js";

export interface RecallOptions {
  scopeTags: string[];        // server-set governance partition, e.g. ["frame:foo"]
  budget: number;
  tokenizer: Tokenizer;
  k?: number;
  filterTags?: string[];      // optional caller narrowing within the authorized scope
  minScore?: number;
}

export class RecallPipeline {
  private readonly embedder: Embedder;
  private readonly memory: MemoryStore;
  private readonly llm?: LlmClient;
  private readonly retriever?: Retriever;
  private readonly defaultK: number;
  constructor(opts: { embedder: Embedder; memory: MemoryStore; llm?: LlmClient; retriever?: Retriever; defaultK?: number }) {
    this.embedder = opts.embedder; this.memory = opts.memory; this.llm = opts.llm;
    this.retriever = opts.retriever;
    this.defaultK = opts.defaultK ?? 50;
  }
  async recall(query: string, opts: RecallOptions): Promise<AssembledContext> {
    if (opts.scopeTags.length === 0) {
      throw new Error(
        "RecallPipeline.recall: scopeTags must be non-empty — a governance partition is required; an empty scope would cross all frames"
      );
    }
    const tags = [...opts.scopeTags, ...(opts.filterTags ?? [])];
    let ranked: Array<{ rec: MemoryRecord; score: number }>;
    if (this.retriever) {
      const scored = await this.retriever.retrieve(query, { scopeTags: tags, k: opts.k ?? this.defaultK });
      ranked = scored.map((s) => ({ rec: s.rec, score: s.score }));
    } else {
      // Use the embedder's asymmetric query embedding when it offers one (e.g.
      // bge's retrieval instruction) — it materially improves query/document
      // alignment over embedding the query as a plain document.
      const embedding = await (this.embedder.embedQuery
        ? this.embedder.embedQuery(query)
        : this.embedder.embed(query));
      ranked = await this.memory.query({ embedding, tags, k: opts.k ?? this.defaultK });
    }
    return assembleContext(ranked, { budget: opts.budget, tokenizer: opts.tokenizer, minScore: opts.minScore });
  }
  async ask(query: string, opts: RecallOptions & { system?: string }):
    Promise<AskResult> {
    if (!this.llm) throw new Error("RecallPipeline.ask: no LlmClient configured");
    const context = await this.recall(query, opts);
    const res = await this.llm.complete({ system: opts.system, context: context.block, query });
    return { answer: res.text, context, usage: res.usage };
  }
}
