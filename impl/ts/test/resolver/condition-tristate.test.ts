/**
 * Conditional-edge fail-closed semantics (root cause F).
 *
 * When a referenced field/node is missing, the condition is INDETERMINATE.
 * An indeterminate condition must leave the edge DORMANT (fail-closed),
 * including under negation — never activate a relationship on absent data.
 *
 * @see cbp-architecture.html Section III (conditional edges)
 */

import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../../src/resolver/condition-eval.js";
import type { CbpNode } from "../../src/types/node.js";

const empty = new Map<string, CbpNode>();

function priorNode(id: string, val: unknown): CbpNode {
  return {
    id,
    type: "prior",
    val,
    w: 1,
    decay: "none",
    ttl: null,
    lineage: null,
    tags: [],
    v: 1,
    prev: null,
  };
}

describe("conditional eval — fail-closed on missing data", () => {
  it("missing field under not() is dormant, not active (the bug)", () => {
    const cond = {
      not: { field: "prior:missing.val.renewal_outlook", op: "eq", value: "healthy" },
    };
    expect(evaluateCondition(cond, empty)).toBe(false);
  });

  it("missing field in a bare leaf is dormant", () => {
    const cond = { field: "prior:missing.val.renewal_outlook", op: "eq", value: "x" };
    expect(evaluateCondition(cond, empty)).toBe(false);
  });

  it("missing field inside all() is dormant", () => {
    const cond = {
      all: [{ field: "prior:missing.val.x", op: "eq", value: 1 }],
    };
    expect(evaluateCondition(cond, empty)).toBe(false);
  });

  it("not(all([missing])) is still dormant — unknown propagates", () => {
    const cond = {
      not: { all: [{ field: "prior:missing.val.x", op: "eq", value: 1 }] },
    };
    expect(evaluateCondition(cond, empty)).toBe(false);
  });

  // --- positive controls: present, decidable data still works both ways ---

  it("not() over a present, non-matching field is active", () => {
    const nodes = new Map<string, CbpNode>([
      ["n1", priorNode("n1", { renewal_outlook: "at_risk" })],
    ]);
    const cond = {
      not: { field: "prior:n1.val.renewal_outlook", op: "eq", value: "healthy" },
    };
    expect(evaluateCondition(cond, nodes)).toBe(true);
  });

  it("exists remains decidable on a missing field (false, not unknown)", () => {
    const cond = { field: "prior:missing.val.x", op: "exists" };
    expect(evaluateCondition(cond, empty)).toBe(false);
  });
});

describe("conditional eval — field accessor <type>: prefix (A7)", () => {
  it("a type-mismatched accessor is indeterminate (dormant), not a silent match", () => {
    // n1 is a 'prior' node. Asserting state:n1 must NOT resolve as if it matched
    // — the accessor's type segment is part of the assertion, fail-closed.
    const nodes = new Map<string, CbpNode>([["n1", priorNode("n1", { renewal_outlook: "at_risk" })]]);
    const cond = { field: "state:n1.val.renewal_outlook", op: "eq", value: "at_risk" };
    expect(evaluateCondition(cond, nodes)).toBe(false);
  });

  it("the correctly-typed accessor still resolves and activates", () => {
    const nodes = new Map<string, CbpNode>([["n1", priorNode("n1", { renewal_outlook: "at_risk" })]]);
    const cond = { field: "prior:n1.val.renewal_outlook", op: "eq", value: "at_risk" };
    expect(evaluateCondition(cond, nodes)).toBe(true);
  });
});

describe("conditional eval — eq/ne are strict-typed but non-throwing (A10)", () => {
  // Pinned behavior: unlike lt/gt (which throw on cross-type), eq/ne use strict
  // ===/!== with no coercion and no throw. A cross-type comparison is a DECIDED
  // result, not an error. This test locks that contract so it can't drift.
  it("eq across types is a decided false (no coercion, no throw)", () => {
    const nodes = new Map<string, CbpNode>([["n1", priorNode("n1", { x: 5 })]]);
    const cond = { field: "prior:n1.val.x", op: "eq", value: "5" };
    expect(evaluateCondition(cond, nodes)).toBe(false);
  });

  it("ne across types is a decided true", () => {
    const nodes = new Map<string, CbpNode>([["n1", priorNode("n1", { x: 5 })]]);
    const cond = { field: "prior:n1.val.x", op: "ne", value: "5" };
    expect(evaluateCondition(cond, nodes)).toBe(true);
  });
});
