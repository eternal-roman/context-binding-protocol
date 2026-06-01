/**
 * Conformance vector harness.
 *
 * Loads every vector under spec/conformance/<domain>/*.json and runs the
 * operations in each one against the reference implementation. This is
 * the language-portable contract that every other CBP implementation
 * (Rust, Python, Go) must pass byte-identically. Activated by
 * `pnpm run conformance` (and also included in `pnpm test`).
 *
 * Operation types supported (per spec/conformance/README.md):
 *   - resolve            → resolve frame, compare nodes/edges partially
 *   - query              → resolve + CBQ filter, compare nodes partially
 *   - serialize          → serializeFrame at a tier, compare wire bytes
 *   - id_derive          → BLAKE3 id derivation, compare prefix
 *   - export_roundtrip   → canonicalize(input) stable across JSON round-trip,
 *                          no resolver-computed fields on edges (v0.7)
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveFrame,
  resolveFrameWithQuery,
} from "../../src/resolver/resolver.js";
import { serializeFrame } from "../../src/serializer/serializer.js";
import { deriveId } from "../../src/graph/id.js";
import { canonicalize } from "../../src/wire/canonical.js";
import { projectFrameNodes } from "../../src/memory/project.js";
import { InMemoryMemoryStore } from "../../src/memory/store.js";
import { HashingEmbedder } from "../../src/memory/embedder.js";
import { assembleContext } from "../../src/recall/assemble.js";
import { getTokenizer } from "../../src/tokenizer/index.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";
import type { FrameConfig } from "../../src/types/frame.js";

const VECTORS_DIR = ((): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = impl/ts/test/conformance
  return join(here, "..", "..", "..", "..", "spec", "conformance");
})();

interface VectorFile {
  vector_id: string;
  version: string;
  domain: string;
  description: string;
  tags?: string[];
  input: {
    frame: FrameConfig;
    nodes: CbpNode[];
    edges: CbpEdge[];
  };
  operations: VectorOperation[];
}

type VectorOperation =
  | {
      op: "resolve";
      description?: string;
      params: Record<string, unknown>;
      expected: {
        nodes?: Array<Record<string, unknown>>;
        edges?: Array<Record<string, unknown>>;
      };
    }
  | {
      op: "query";
      description?: string;
      params: { cbq: string };
      expected: { nodes?: Array<Record<string, unknown>> };
    }
  | {
      op: "serialize";
      description?: string;
      params: { tier: "full" | "condensed" | "signal" };
      expected: { wire?: string };
    }
  | {
      op: "id_derive";
      description?: string;
      params: { node: Pick<CbpNode, "type" | "val" | "lineage" | "tags"> };
      expected: { id: string };
    }
  | {
      op: "export_roundtrip";
      description?: string;
      params: Record<string, unknown>;
      expected: {
        roundtrip: "byte_identical";
        must_not_contain_on_edges?: string[];
      };
    }
  | {
      op: "recall";
      description?: string;
      params: { query: string; dim: number; k?: number; budget: number; minScore?: number };
      expected: { first_id?: string; admitted_ids?: string[]; tokens_le_budget?: boolean };
    };

function loadVectors(): Array<{ relativePath: string; vector: VectorFile }> {
  const domains = readdirSync(VECTORS_DIR).filter((entry) => {
    const full = join(VECTORS_DIR, entry);
    return statSync(full).isDirectory();
  });

  const out: Array<{ relativePath: string; vector: VectorFile }> = [];
  for (const domain of domains) {
    const domainDir = join(VECTORS_DIR, domain);
    const files = readdirSync(domainDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const full = join(domainDir, file);
      const raw = readFileSync(full, "utf-8");
      out.push({
        relativePath: `${domain}/${file}`,
        vector: JSON.parse(raw) as VectorFile,
      });
    }
  }
  return out;
}

/**
 * Deep-equals for conformance comparisons. Arrays are treated as
 * multisets — tags, domain_tags, and the nodes/edges lists themselves
 * have no semantic ordering in the protocol, so a language port that
 * merges tags in a different order is still conforming.
 */
function fieldsEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = a.map((x) => JSON.stringify(x)).sort();
    const sb = b.map((x) => JSON.stringify(x)).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Partial-match check. Each expected entry may specify any subset of the
 * fields; a matching actual entry must have equal values for every field
 * the expected entry declares (arrays as multisets). Expected.length must
 * equal actual.length (no extras, no omissions).
 */
function matchesPartial(
  actual: Array<Record<string, unknown>>,
  expected: Array<Record<string, unknown>>
): void {
  expect(actual).toHaveLength(expected.length);
  for (const exp of expected) {
    const matched = actual.some((a) => {
      for (const key of Object.keys(exp)) {
        if (!fieldsEqual(a[key], exp[key])) return false;
      }
      return true;
    });
    if (!matched) {
      throw new Error(
        `No actual entry matched expected fields ${JSON.stringify(exp)}\n` +
          `Actual: ${JSON.stringify(actual, null, 2)}`
      );
    }
  }
}

const vectors = loadVectors();

describe("Conformance vectors (spec/conformance/)", () => {
  if (vectors.length === 0) {
    it("finds at least one vector", () => {
      throw new Error(`No vectors found under ${VECTORS_DIR}`);
    });
    return;
  }

  for (const { relativePath, vector } of vectors) {
    describe(`${relativePath} — ${vector.vector_id}`, () => {
      for (let i = 0; i < vector.operations.length; i++) {
        const op = vector.operations[i] as VectorOperation;
        const label = `op[${i}] ${op.op}${op.description ? ` — ${op.description}` : ""}`;

        it(label, async () => {
          const input: FrameInput = vector.input;

          switch (op.op) {
            case "resolve": {
              const resolved = resolveFrame(input);
              if (op.expected.nodes) {
                matchesPartial(
                  resolved.nodes as unknown as Array<Record<string, unknown>>,
                  op.expected.nodes
                );
              }
              if (op.expected.edges) {
                matchesPartial(
                  resolved.edges as unknown as Array<Record<string, unknown>>,
                  op.expected.edges
                );
              }
              break;
            }

            case "query": {
              const resolved = resolveFrameWithQuery(input, op.params.cbq);
              if (op.expected.nodes) {
                matchesPartial(
                  resolved.nodes as unknown as Array<Record<string, unknown>>,
                  op.expected.nodes
                );
              }
              break;
            }

            case "serialize": {
              const resolved = resolveFrame(input);
              const result = serializeFrame(resolved, 1, { tier: op.params.tier });
              if (op.expected.wire !== undefined) {
                expect(result.wire).toBe(op.expected.wire);
              }
              break;
            }

            case "id_derive": {
              const id = deriveId(op.params.node);
              // Vectors may specify a prefix (first 8 hex chars) or the full hash.
              expect(id.startsWith(op.expected.id)).toBe(true);
              break;
            }

            case "export_roundtrip": {
              // Contract: canonicalize of the stored shape is stable across
              // a mechanical JSON round-trip, and the export must never
              // carry resolver-computed fields on edges.
              const canonicalNodes = canonicalize(input.nodes);
              const canonicalEdges = canonicalize(input.edges);
              const roundtrippedNodes = JSON.parse(
                JSON.stringify(input.nodes)
              ) as unknown;
              const roundtrippedEdges = JSON.parse(
                JSON.stringify(input.edges)
              ) as unknown;
              expect(canonicalize(roundtrippedNodes)).toBe(canonicalNodes);
              expect(canonicalize(roundtrippedEdges)).toBe(canonicalEdges);

              const forbidden = op.expected.must_not_contain_on_edges ?? [];
              for (const edge of input.edges) {
                for (const field of forbidden) {
                  expect((edge as Record<string, unknown>)[field]).toBeUndefined();
                }
              }
              break;
            }

            case "recall": {
              const resolved = resolveFrame(input);
              const embedder = new HashingEmbedder(op.params.dim);
              const tokenizer = getTokenizer(input.frame.tokenizer);
              const records = await projectFrameNodes(resolved.nodes, { tokenizer, embedder });
              const memory = new InMemoryMemoryStore();
              for (const r of records) await memory.upsert(r);
              const ranked = await memory.query({ embedding: await embedder.embed(op.params.query), k: op.params.k ?? 50 });
              const ctx = assembleContext(ranked, { budget: op.params.budget, tokenizer, minScore: op.params.minScore });
              if (op.expected.first_id !== undefined) {
                expect(ctx.entries[0]?.id).toBe(op.expected.first_id);
              }
              if (op.expected.tokens_le_budget) {
                expect(ctx.tokensUsed).toBeLessThanOrEqual(op.params.budget);
              }
              if (op.expected.admitted_ids) {
                expect(ctx.entries.map((e) => e.id).sort()).toEqual([...op.expected.admitted_ids].sort());
              }
              break;
            }

            default: {
              // Unknown op type — fail loudly so new operations added to a
              // vector before the harness supports them don't pass silently.
              const unknown = op as { op: string };
              throw new Error(`Unsupported conformance op: ${unknown.op}`);
            }
          }
        });
      }
    });
  }
});
