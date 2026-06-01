/**
 * Tests for w/decay/ttl field inheritance.
 *
 * Verifies that the inheritance resolver actually propagates w, decay, and ttl
 * from parent nodes to children that omit those fields (undefined = inherit).
 *
 * @see cbp-architecture.html Section II — Inheritance Resolution
 */

import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { resolveInheritance } from "../../src/resolver/inheritance.js";
import type { CbpNode } from "../../src/types/node.js";

/**
 * Build a node object, allowing w/decay/ttl to be omitted (undefined)
 * to test inheritance. Uses type assertion to bypass Zod's required fields
 * since loadNode() doesn't validate — it stores the raw object.
 */
function makeNode(overrides: {
  id: string;
  type: CbpNode["type"];
  lineage: string | null;
  tags?: string[];
  w?: number;
  decay?: CbpNode["decay"];
  ttl?: number | null;
  val?: unknown;
}): CbpNode {
  const base: Record<string, unknown> = {
    id: overrides.id,
    type: overrides.type,
    val: overrides.val ?? {},
    lineage: overrides.lineage,
    tags: overrides.tags ?? [],
    v: 1,
    prev: null,
  };

  // Only set w/decay/ttl if explicitly provided — omission = undefined = inherit
  if (overrides.w !== undefined) base.w = overrides.w;
  if (overrides.decay !== undefined) base.decay = overrides.decay;
  if (overrides.ttl !== undefined) base.ttl = overrides.ttl;

  return base as CbpNode;
}

describe("Inheritance — w/decay/ttl field propagation", () => {
  describe("single-level inheritance (frame -> child)", () => {
    it("child inherits w from parent when w is undefined", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000001",
        type: "frame",
        lineage: null,
        w: 0.85,
        decay: "epoch",
        ttl: 3600,
      });
      const child = makeNode({
        id: "bb000001",
        type: "entity",
        lineage: "aa000001",
        // w omitted — should inherit 0.85
        decay: "event",
        ttl: 7200,
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000001", store);
      expect(resolved.w).toBe(0.85);
    });

    it("child inherits decay from parent when decay is undefined", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000002",
        type: "frame",
        lineage: null,
        w: 1.0,
        decay: "none",
        ttl: null,
      });
      const child = makeNode({
        id: "bb000002",
        type: "entity",
        lineage: "aa000002",
        w: 0.5,
        // decay omitted — should inherit "none"
        ttl: 1800,
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000002", store);
      expect(resolved.decay).toBe("none");
    });

    it("child inherits ttl from parent when ttl is undefined", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000003",
        type: "frame",
        lineage: null,
        w: 1.0,
        decay: "epoch",
        ttl: 9999,
      });
      const child = makeNode({
        id: "bb000003",
        type: "entity",
        lineage: "aa000003",
        w: 0.7,
        decay: "event",
        // ttl omitted — should inherit 9999
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000003", store);
      expect(resolved.ttl).toBe(9999);
    });

    it("child inherits all three fields when all are undefined", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000004",
        type: "frame",
        lineage: null,
        w: 0.6,
        decay: "event",
        ttl: 500,
      });
      const child = makeNode({
        id: "bb000004",
        type: "entity",
        lineage: "aa000004",
        // all three omitted
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000004", store);
      expect(resolved.w).toBe(0.6);
      expect(resolved.decay).toBe("event");
      expect(resolved.ttl).toBe(500);
    });
  });

  describe("explicit child values override parent", () => {
    it("child's explicit w overrides parent's w", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000010",
        type: "frame",
        lineage: null,
        w: 0.85,
        decay: "epoch",
        ttl: 3600,
      });
      const child = makeNode({
        id: "bb000010",
        type: "entity",
        lineage: "aa000010",
        w: 0.3,       // explicit override
        decay: "epoch",
        ttl: 3600,
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000010", store);
      expect(resolved.w).toBe(0.3);
    });

    it("child's explicit decay overrides parent's decay", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000011",
        type: "frame",
        lineage: null,
        w: 1.0,
        decay: "none",
        ttl: null,
      });
      const child = makeNode({
        id: "bb000011",
        type: "entity",
        lineage: "aa000011",
        w: 1.0,
        decay: "event",  // explicit override
        ttl: null,
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000011", store);
      expect(resolved.decay).toBe("event");
    });

    it("mixed: child inherits w, overrides decay and ttl", () => {
      const store = new GraphStore();
      const parent = makeNode({
        id: "aa000012",
        type: "frame",
        lineage: null,
        w: 0.9,
        decay: "epoch",
        ttl: 3600,
      });
      const child = makeNode({
        id: "bb000012",
        type: "entity",
        lineage: "aa000012",
        // w omitted — should inherit 0.9
        decay: "none",  // explicit
        ttl: 100,       // explicit
      });

      store.loadNode(parent);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000012", store);
      expect(resolved.w).toBe(0.9);
      expect(resolved.decay).toBe("none");
      expect(resolved.ttl).toBe(100);
    });
  });

  describe("multi-level inheritance (frame -> entity -> state)", () => {
    it("state inherits from entity which inherits from frame", () => {
      const store = new GraphStore();
      const frame = makeNode({
        id: "aa000020",
        type: "frame",
        lineage: null,
        w: 0.8,
        decay: "epoch",
        ttl: 7200,
      });
      const entity = makeNode({
        id: "bb000020",
        type: "entity",
        lineage: "aa000020",
        // w omitted — inherits 0.8 from frame
        decay: "event",  // overrides frame's "epoch"
        // ttl omitted — inherits 7200 from frame
      });
      const state = makeNode({
        id: "cc000020",
        type: "state",
        lineage: "bb000020",
        // all omitted — should inherit from entity (and transitively from frame)
      });

      store.loadNode(frame);
      store.loadNode(entity);
      store.loadNode(state);

      const resolved = resolveInheritance("cc000020", store);
      // w: entity has undefined, so state walks past entity to frame -> 0.8
      expect(resolved.w).toBe(0.8);
      // decay: entity has "event", so state inherits from entity
      expect(resolved.decay).toBe("event");
      // ttl: entity has undefined, so state walks past entity to frame -> 7200
      expect(resolved.ttl).toBe(7200);
    });

    it("middle entity overrides w, grandchild inherits from entity not frame", () => {
      const store = new GraphStore();
      const frame = makeNode({
        id: "aa000021",
        type: "frame",
        lineage: null,
        w: 1.0,
        decay: "none",
        ttl: null,
      });
      const entity = makeNode({
        id: "bb000021",
        type: "entity",
        lineage: "aa000021",
        w: 0.5,         // overrides frame
        // decay omitted — inherits "none" from frame
        ttl: 600,        // overrides frame's null
      });
      const state = makeNode({
        id: "cc000021",
        type: "state",
        lineage: "bb000021",
        // all omitted — should inherit from nearest ancestor with value
      });

      store.loadNode(frame);
      store.loadNode(entity);
      store.loadNode(state);

      const resolved = resolveInheritance("cc000021", store);
      // w: entity has 0.5, state inherits from entity
      expect(resolved.w).toBe(0.5);
      // decay: entity has undefined, walks to frame -> "none"
      expect(resolved.decay).toBe("none");
      // ttl: entity has 600, state inherits from entity
      expect(resolved.ttl).toBe(600);
    });
  });

  describe("spec defaults when no ancestor has a value", () => {
    it("falls back to spec defaults when entire chain omits fields", () => {
      const store = new GraphStore();
      const frame = makeNode({
        id: "aa000030",
        type: "frame",
        lineage: null,
        // all three omitted
      });
      const child = makeNode({
        id: "bb000030",
        type: "entity",
        lineage: "aa000030",
        // all three omitted
      });

      store.loadNode(frame);
      store.loadNode(child);

      const resolved = resolveInheritance("bb000030", store);
      // Spec defaults: w=1.0, decay="epoch", ttl=null
      expect(resolved.w).toBe(1.0);
      expect(resolved.decay).toBe("epoch");
      expect(resolved.ttl).toBeNull();
    });
  });

  describe("frame root (no lineage) gets spec defaults", () => {
    it("frame root with omitted fields gets spec defaults applied", () => {
      const store = new GraphStore();
      const frame = makeNode({
        id: "aa000040",
        type: "frame",
        lineage: null,
        // all three omitted
      });

      store.loadNode(frame);

      const resolved = resolveInheritance("aa000040", store);
      // Frame root has no parent, so spec defaults should apply
      expect(resolved.w).toBe(1.0);
      expect(resolved.decay).toBe("epoch");
      expect(resolved.ttl).toBeNull();
    });
  });
});
