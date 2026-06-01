/**
 * CBQ result-consistency invariant (root cause E).
 *
 * A CBQ query may filter out nodes. Every edge in the result MUST have
 * both endpoints present in the result's node set — otherwise the
 * serialized frame references nonexistent nodes.
 *
 * @see cbp-architecture.html Section V (CBQ)
 */

import { describe, it, expect } from "vitest";
import { resolveFrameWithQuery } from "../../src/resolver/resolver.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import type { FrameConfig } from "../../src/types/frame.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

const frame: FrameConfig = {
  id: "test_frame",
  domain_tags: [],
  root_weight: 1.0,
  root_decay: "none",
  refresh_policy: "on_demand",
  max_token_budget: 4000,
  inheritance_mode: "prototypal",
  conditional_edge_eval: "eager",
  tokenizer: "o200k_base",
  acl_tags: [],
};

const root: CbpNode = {
  id: "f0000001",
  type: "frame",
  val: { name: "root" },
  w: 1.0,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: [],
  v: 1,
  prev: null,
};

const hi: CbpNode = {
  id: "a0000001",
  type: "entity",
  val: "HIGH",
  w: 0.9,
  decay: "none",
  ttl: null,
  lineage: "f0000001",
  tags: [],
  v: 1,
  prev: null,
};

const lo: CbpNode = {
  id: "b0000001",
  type: "entity",
  val: "LOW",
  w: 0.1,
  decay: "none",
  ttl: null,
  lineage: "f0000001",
  tags: [],
  v: 1,
  prev: null,
};

const edge: CbpEdge = {
  id: "e0000001",
  src: "a0000001", // hi
  tgt: "b0000001", // lo
  rel: "correlates",
  strength: 0.8,
  conditional: "always",
  w: 1.0,
  decay: "none",
  ttl: null,
  v: 1,
  prev: null,
};

const input: FrameInput = { frame, nodes: [root, hi, lo], edges: [edge] };

describe("CBQ result consistency", () => {
  it("drops edges whose endpoints were filtered out by a node predicate", () => {
    const resolved = resolveFrameWithQuery(input, "w>0.5");
    const nodeIds = new Set(resolved.nodes.map((n) => n.id));

    // lo was filtered out (w=0.1)
    expect(nodeIds.has("b0000001")).toBe(false);
    // therefore the hi→lo edge must not survive
    expect(resolved.edges.find((e) => e.id === "e0000001")).toBeUndefined();
  });

  it("every returned edge has both endpoints present (general invariant)", () => {
    const resolved = resolveFrameWithQuery(input, "w>0.5");
    const nodeIds = new Set(resolved.nodes.map((n) => n.id));
    for (const e of resolved.edges) {
      expect(nodeIds.has(e.src)).toBe(true);
      expect(nodeIds.has(e.tgt)).toBe(true);
    }
  });
});
