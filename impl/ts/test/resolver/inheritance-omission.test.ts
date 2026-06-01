/**
 * Prototypal inheritance — "omit ⇒ inherit" (invariant #2).
 *
 * The declarative model: a child node may OMIT w/decay/ttl and inherit them
 * from its lineage; an explicitly declared field overrides. `override_only`
 * mode disables inheritance (omitted fields get spec defaults, not the
 * parent's value). Decay materializes an inherited weight on first touch.
 *
 * Before this change the node schema required w/decay/ttl, so omission was
 * impossible and the resolver's ancestor-walk was unreachable.
 *
 * @see cbp-architecture.html Section II (inheritance), Section X invariant #2
 */

import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInheritance } from "../../src/resolver/inheritance.js";
import { DecayEngine } from "../../src/decay/engine.js";

describe("prototypal inheritance — omit ⇒ inherit", () => {
  it("a child that omits w/decay/ttl inherits them from its parent", () => {
    const store = new GraphStore();
    const root = store.insertNode({
      type: "frame",
      val: { name: "root" },
      w: 0.6,
      decay: "none",
      ttl: 1000,
      lineage: null,
      tags: ["domain:x"],
    });
    const child = store.insertNode({
      type: "entity",
      val: "BTC",
      lineage: root.id,
      tags: [],
    });

    // stored child has no own w/decay/ttl
    expect(store.getNode(child.id)?.w).toBeUndefined();

    const resolved = resolveInheritance(child.id, store);
    expect(resolved.w).toBe(0.6);
    expect(resolved.decay).toBe("none");
    expect(resolved.ttl).toBe(1000);
    expect(resolved.tags).toContain("domain:x"); // tags merge from ancestors
  });

  it("an explicit field on the child overrides the inherited value", () => {
    const store = new GraphStore();
    const root = store.insertNode({
      type: "frame",
      val: {},
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
    });
    const child = store.insertNode({
      type: "entity",
      val: "X",
      w: 0.95,
      lineage: root.id,
      tags: [],
    });

    const resolved = resolveInheritance(child.id, store);
    expect(resolved.w).toBe(0.95); // own value wins
    expect(resolved.decay).toBe("none"); // still inherited
  });

  it("override_only mode does not inherit; omitted fields get spec defaults", () => {
    const store = new GraphStore();
    const root = store.insertNode({
      type: "frame",
      val: {},
      w: 0.6,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
    });
    const child = store.insertNode({
      type: "entity",
      val: "X",
      lineage: root.id,
      tags: [],
    });

    const resolved = resolveInheritance(child.id, store, "override_only");
    expect(resolved.w).toBe(1.0); // spec default, NOT the parent's 0.6
    expect(resolved.decay).toBe("epoch"); // spec default
  });

  it("decay materializes an inherited weight on first touch (option A)", () => {
    const store = new GraphStore();
    const root = store.insertNode({
      type: "frame",
      val: {},
      w: 0.8,
      decay: "epoch",
      ttl: null,
      lineage: null,
      tags: [],
    });
    const child = store.insertNode({
      type: "state",
      val: { x: 1 },
      lineage: root.id,
      tags: [],
    }); // omits w + decay → inherits w=0.8, decay=epoch

    expect(store.getNode(child.id)?.w).toBeUndefined(); // not stored yet

    const engine = new DecayEngine({ decayFactor: 0.5, gcThreshold: 0 });
    engine.sweep(store);

    const after = store.getNode(child.id);
    expect(after?.w).toBeCloseTo(0.4); // materialized: inherited 0.8 × 0.5
  });
});
