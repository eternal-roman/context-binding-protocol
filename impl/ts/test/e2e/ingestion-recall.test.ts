/**
 * End-to-end: ingestion → mutation → recall.
 *
 * Exercises the full loop an agent uses — write a graph, mutate state,
 * then recall it as a serialized frame at every tier — and asserts the
 * recalled context is clean and consistent:
 *   - only LIVE nodes are recalled (no superseded historical versions)
 *   - no node id appears twice
 *   - every edge endpoint is present in the recalled node set
 *   - the serialized payload never exceeds the frame's token budget
 *
 * @see cbp-architecture.html §VI Mode 4 (embedded SDK)
 */

import { describe, it, expect } from "vitest";
import { CbpClient } from "../../src/sdk/client.js";
import type { FrameConfig } from "../../src/types/frame.js";
import type { CbpEdge } from "../../src/types/edge.js";
import "../../src/tokenizer/index.js";

const frameConfig: FrameConfig = {
  id: "e2e_frame",
  domain_tags: ["domain:test"],
  root_weight: 1.0,
  root_decay: "none",
  refresh_policy: "on_demand",
  max_token_budget: 4000,
  inheritance_mode: "prototypal",
  conditional_edge_eval: "eager",
  tokenizer: "o200k_base",
  acl_tags: [],
};

describe("end-to-end ingestion → recall", () => {
  it("ingests a graph, mutates state, and recalls a clean consistent frame", () => {
    const client = new CbpClient({ frameConfig, writeAccess: true });

    // --- Ingestion: build a small domain graph ---
    const root = client.store.insertNode({
      type: "frame",
      val: { name: "e2e" },
      w: 1.0,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: ["domain:test"],
    });
    const acme = client.store.insertNode({
      type: "entity",
      val: "Acme Corp",
      w: 0.9,
      decay: "epoch",
      ttl: null,
      lineage: root.id,
      tags: [],
    });
    const globex = client.store.insertNode({
      type: "entity",
      val: "Globex Inc",
      w: 0.8,
      decay: "epoch",
      ttl: null,
      lineage: root.id,
      tags: [],
    });
    const price = client.store.insertNode({
      type: "state",
      val: { price: 100 },
      w: 0.7,
      decay: "event",
      ttl: null,
      lineage: acme.id, // leaf under Acme Corp, no edges
      tags: [],
    });

    const edge: CbpEdge = {
      id: "ed000001",
      src: acme.id,
      tgt: globex.id,
      rel: "correlates",
      strength: 0.85,
      conditional: "always",
      w: 1.0,
      decay: "none",
      ttl: null,
      v: 1,
      prev: null,
    };
    client.loadEdges([edge]);

    // --- Mutation: change the state's content (creates a new version) ---
    const price2 = client.upsert(price.id, { val: { price: 200 } }, price.v);
    expect(price2.id).not.toBe(price.id); // content change → new content-addressed id

    // --- Recall: resolve and assert consistency ---
    const resolved = client.resolve();
    const ids = resolved.nodes.map((n) => n.id);

    // only the live version of the state is recalled
    expect(ids).toContain(price2.id);
    expect(ids).not.toContain(price.id);

    // no duplicate node ids
    expect(new Set(ids).size).toBe(ids.length);

    // every edge endpoint is present in the recalled node set
    const idSet = new Set(ids);
    for (const e of resolved.edges) {
      expect(idSet.has(e.src)).toBe(true);
      expect(idSet.has(e.tgt)).toBe(true);
    }

    // inheritance flowed: Acme Corp inherits the domain:test tag from the root
    const acmeResolved = resolved.nodes.find((n) => n.id === acme.id);
    expect(acmeResolved?.tags).toContain("domain:test");

    // --- Recall at every tier: each fits the token budget (invariant #1) ---
    for (const tier of ["full", "condensed", "signal"] as const) {
      const out = client.serialize(tier);
      expect(out.tokens).toBeGreaterThan(0);
      expect(out.tokens).toBeLessThanOrEqual(frameConfig.max_token_budget);
    }
  });
});
