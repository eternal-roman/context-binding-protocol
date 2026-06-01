import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import type { CbpEdge } from "../../src/types/edge.js";

const N = (val: string): Parameters<GraphStore["insertNode"]>[0] =>
  ({ type: "state", val, lineage: null, tags: [], w: 1, decay: "none", ttl: null });

describe("GraphStore hardening", () => {
  it("does not resurrect a superseded predecessor when its head is deleted", () => {
    const s = new GraphStore({ maxNodesPerFrame: 10 });
    const a = s.insertNode(N("v1"));
    const b = s.upsertNode(a.id, { val: "v2" }, a.v); // a superseded by b
    expect(s.getLiveNodes().map((n) => n.id)).toEqual([b.id]);

    s.removeNode(b.id); // delete the head
    expect(s.getLiveNodes()).toEqual([]); // a stays tombstoned — no stale-content resurrection
    expect(s.liveNodeCount).toBe(0);
  });

  it("getNodeByContent dedups on the full content hash and self-heals after delete", () => {
    const s = new GraphStore();
    const n = s.insertNode(N("hello world"));
    expect(s.getNodeByContent({ type: "state", val: "hello world", lineage: null, tags: [] })?.id).toBe(n.id);
    expect(s.getNodeByContent({ type: "state", val: "other", lineage: null, tags: [] })).toBeUndefined();
    s.removeNode(n.id);
    expect(s.getNodeByContent({ type: "state", val: "hello world", lineage: null, tags: [] })).toBeUndefined();
  });

  it("getEdgesForNode uses the reverse index and reflects edge removal", () => {
    const s = new GraphStore();
    const a = s.insertNode(N("a"));
    const b = s.insertNode(N("b"));
    const edge: CbpEdge = { id: "e1", src: a.id, tgt: b.id, rel: "requires", strength: 1, conditional: "always", w: 1, decay: "none", v: 1 };
    s.loadEdge(edge);
    expect(s.getEdgesForNode(a.id).map((e) => e.id)).toEqual(["e1"]);
    expect(s.getEdgesForNode(b.id).map((e) => e.id)).toEqual(["e1"]);
    s.removeEdge("e1");
    expect(s.getEdgesForNode(a.id)).toEqual([]);
    expect(s.getEdgesForNode(b.id)).toEqual([]);
  });
});
