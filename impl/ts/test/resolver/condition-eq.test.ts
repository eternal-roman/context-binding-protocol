import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../../src/resolver/condition-eval.js";
import type { CbpNode } from "../../src/types/node.js";

function priorNode(id: string, val: unknown): CbpNode {
  return { id, type: "prior", val, lineage: null, tags: [], v: 1, prev: null, w: 1, decay: "none", ttl: null };
}

describe("condition eq/ne — structural equality for object/array operands", () => {
  const nodes = new Map<string, CbpNode>([["n1", priorNode("n1", { regime: "risk_on" })]]);

  it("eq matches an object field by value, not reference identity", () => {
    expect(evaluateCondition({ field: "prior:n1.val", op: "eq", value: { regime: "risk_on" } }, nodes)).toBe(true);
    expect(evaluateCondition({ field: "prior:n1.val", op: "eq", value: { regime: "risk_off" } }, nodes)).toBe(false);
  });

  it("ne is the structural negation", () => {
    expect(evaluateCondition({ field: "prior:n1.val", op: "ne", value: { regime: "risk_off" } }, nodes)).toBe(true);
    expect(evaluateCondition({ field: "prior:n1.val", op: "ne", value: { regime: "risk_on" } }, nodes)).toBe(false);
  });

  it("still compares primitives exactly (no coercion)", () => {
    const scalar = new Map<string, CbpNode>([["s1", priorNode("s1", 5)]]);
    expect(evaluateCondition({ field: "prior:s1.val", op: "eq", value: 5 }, scalar)).toBe(true);
    expect(evaluateCondition({ field: "prior:s1.val", op: "eq", value: "5" }, scalar)).toBe(false); // number !== string
  });
});
