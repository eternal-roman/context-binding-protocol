import type { LlmClient } from "../recall/llm.js";
import { Fact } from "./types.js";
import type { ExtractStats } from "./types.js";
import { chunk } from "./chunk.js";

// Default handler logs ONLY safe metadata — the chunk number and the error's
// TYPE — never err.message, which can contain document text or a
// provider-echoed response body (sensitive-to-observability). A caller that
// needs full error detail can inject its own onChunkError and decide what is
// safe to write to its logs (cf. the OpenAiCompatLlmClient JSDoc in llm.ts).
const defaultOnChunkError = (err: unknown, chunkIndex: number): void =>
  console.error(
    `LlmExtractor: chunk ${chunkIndex + 1} extraction failed (${err instanceof Error ? err.constructor.name : typeof err})`
  );

export interface Extractor {
  extract(document: string): Promise<{ facts: Fact[]; stats: ExtractStats }>;
}

const SYSTEM = [
  "You extract atomic, self-contained facts from a document for a memory system.",
  "Return ONLY a JSON array (no prose, no markdown fences). Each element:",
  '  { "type": "entity"|"state"|"prior", "val": "<one self-contained fact>", "tags": ["..."], "w": <0..1 importance> }',
  "Rules: one fact per element; make each `val` understandable on its own",
  "(resolve pronouns); 'entity' = a thing/person/system, 'state' = a current",
  "condition/policy/value, 'prior' = a decision/rule/guidance. Skip boilerplate.",
].join("\n");

const INSTRUCTION = "Extract the facts as a JSON array.";

function parseFacts(content: string): unknown[] {
  let json = content.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  if (!json.startsWith("[")) {
    const m = json.match(/\[[\s\S]*\]/);
    if (m) json = m[0];
  }
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("extractor did not return a JSON array");
  return parsed;
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** LLM-backed extractor. The LlmClient is injected, so this is deterministically testable. */
export class LlmExtractor implements Extractor {
  constructor(
    private readonly llm: LlmClient,
    private readonly opts: { maxChars?: number; maxChunks?: number; onChunkError?: (err: unknown, chunkIndex: number) => void } = {},
  ) {}

  async extract(document: string): Promise<{ facts: Fact[]; stats: ExtractStats }> {
    const { chunks, truncated } = chunk(document, this.opts.maxChars ?? 5000, this.opts.maxChunks ?? 8);
    const facts: Fact[] = [];
    const seen = new Set<string>();
    let failedChunks = 0;

    for (const [ci, c] of chunks.entries()) {
      try {
        const res = await this.llm.complete({ system: SYSTEM, context: c, query: INSTRUCTION });
        for (const raw of parseFacts(res.text)) {
          const parsed = Fact.safeParse(raw);
          if (!parsed.success) continue;
          const key =
            typeof parsed.data.val === "string"
              ? norm(parsed.data.val)
              : JSON.stringify(parsed.data.val);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          facts.push(parsed.data);
        }
      } catch (err) {
        (this.opts.onChunkError ?? defaultOnChunkError)(err, ci);
        failedChunks++;   // one bad chunk (LLM error OR unparseable response) must not abort the run
      }
    }

    return { facts, stats: { chunks: chunks.length, truncated, facts: facts.length, failedChunks } };
  }
}
