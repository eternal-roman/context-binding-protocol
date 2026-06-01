import { describe, it, expect } from "vitest";
import { evaluateCondition, ConditionEvalError } from "../../src/resolver/condition-eval.js";
import type { Condition } from "../../src/types/edge.js";
import type { CbpNode } from "../../src/types/node.js";

// Build a condition nested `n` levels deep: not(not(not(... "always"))).
function deepNot(n: number): Condition {
  let c: Condition = "always";
  for (let i = 0; i < n; i++) c = { not: c };
  return c;
}

describe("conditional-edge recursion guard (DoS backstop)", () => {
  const nodes = new Map<string, CbpNode>();

  it("throws a typed ConditionEvalError on an over-deep condition (not a stack overflow)", () => {
    // 5000 deep would overflow the stack without the depth guard.
    expect(() => evaluateCondition(deepNot(5000), nodes)).toThrow(ConditionEvalError);
  });

  it("still evaluates normal shallow conditions", () => {
    expect(evaluateCondition("always", nodes)).toBe(true);
    expect(evaluateCondition({ not: "always" }, nodes)).toBe(false);
    expect(evaluateCondition({ all: ["always", "always"] }, nodes)).toBe(true);
  });
});
