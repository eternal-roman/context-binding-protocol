/**
 * S2 — the `matches` conditional operator must be ReDoS-safe.
 *
 * `new RegExp(pattern).test(subject)` is vulnerable to catastrophic
 * backtracking: the 6-character pattern `(a+)+$` against an all-`a`
 * subject runs in exponential time and freezes the event loop. The
 * v0.8.2 200-char pattern cap did not help — the dangerous patterns are
 * short and the subject was uncapped.
 *
 * The fix routes `matches` through `safeMatch`, backed by RE2 (a
 * finite-automaton engine that matches in time linear in the subject and
 * cannot backtrack), plus subject/pattern length caps. These tests pin:
 *   1. a pathological pattern resolves quickly (linear time);
 *   2. over-long subject / pattern are rejected;
 *   3. legitimate patterns still match (feature preserved);
 *   4. unsupported (backtracking-enabling) constructs are rejected;
 *   5. the operator works end-to-end through evaluateCondition.
 *
 * @see cbp-architecture.html Section III — Conditional Edge Activation
 */

import { describe, it, expect } from "vitest";
import {
  safeMatch,
  SafeMatchError,
  MAX_MATCH_SUBJECT,
  MAX_MATCH_PATTERN,
} from "../../src/resolver/safe-match.js";
import {
  evaluateCondition,
  ConditionEvalError,
} from "../../src/resolver/condition-eval.js";
import type { CbpNode } from "../../src/types/node.js";

describe("safeMatch — linear-time, no catastrophic backtracking (S2)", () => {
  it("evaluates a pathological pattern in linear time", () => {
    // Under a backtracking engine `(a+)+$` over a long subject is ~2^n
    // steps (an effective hang). RE2 is linear in the subject length, so
    // even the worst legitimate input (a subject at the cap) returns fast.
    const subject = "a".repeat(MAX_MATCH_SUBJECT);
    const start = performance.now();
    const result = safeMatch("(a+)+$", subject);
    const elapsed = performance.now() - start;
    expect(typeof result).toBe("boolean");
    expect(elapsed).toBeLessThan(500);
  });

  it("rejects a subject longer than the cap", () => {
    expect(() => safeMatch("abc", "a".repeat(MAX_MATCH_SUBJECT + 1))).toThrow(
      SafeMatchError
    );
  });

  it("rejects a pattern longer than the cap", () => {
    expect(() => safeMatch("a".repeat(MAX_MATCH_PATTERN + 1), "x")).toThrow(
      SafeMatchError
    );
  });

  it("rejects invalid regex syntax", () => {
    expect(() => safeMatch("[invalid", "x")).toThrow(SafeMatchError);
  });

  it("rejects unsupported backtracking constructs (backreference)", () => {
    expect(() => safeMatch("(.)\\1", "aa")).toThrow(SafeMatchError);
  });

  it("rejects unsupported backtracking constructs (lookahead)", () => {
    expect(() => safeMatch("foo(?=bar)", "foobar")).toThrow(SafeMatchError);
  });
});

describe("safeMatch — feature preserved for legitimate patterns (S2)", () => {
  it("anchored prefix matches", () => {
    expect(safeMatch("^BTC", "BTC-USD")).toBe(true);
    expect(safeMatch("^BTC", "X-BTC")).toBe(false);
  });

  it("alternation matches", () => {
    expect(safeMatch("risk_(on|off)", "regime:risk_on")).toBe(true);
    expect(safeMatch("risk_(on|off)", "regime:neutral")).toBe(false);
  });

  it("character classes and quantifiers match", () => {
    expect(safeMatch("^[0-9]{3}-[0-9]{4}$", "555-1234")).toBe(true);
    expect(safeMatch("^[0-9]{3}-[0-9]{4}$", "abc-defg")).toBe(false);
  });
});

describe("matches operator end-to-end via evaluateCondition (S2)", () => {
  function nodeSet(val: unknown): ReadonlyMap<string, CbpNode> {
    const node: CbpNode = {
      id: "n1",
      type: "entity",
      val,
      w: 1,
      decay: "none",
      ttl: null,
      lineage: null,
      tags: [],
      v: 1,
      prev: null,
    };
    return new Map([["n1", node]]);
  }

  it("activates on a legitimate pattern match", () => {
    const ok = evaluateCondition(
      { field: "entity:n1.val", op: "matches", value: "risk_(on|off)" },
      nodeSet("risk_on")
    );
    expect(ok).toBe(true);
  });

  it("does not activate on a non-matching pattern", () => {
    const ok = evaluateCondition(
      { field: "entity:n1.val", op: "matches", value: "^ETH$" },
      nodeSet("BTC")
    );
    expect(ok).toBe(false);
  });

  it("a pathological pattern resolves quickly (no event-loop freeze)", () => {
    const start = performance.now();
    const r = evaluateCondition(
      { field: "entity:n1.val", op: "matches", value: "(a+)+$" },
      nodeSet("a".repeat(MAX_MATCH_SUBJECT))
    );
    expect(typeof r).toBe("boolean");
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("surfaces an over-long subject as ConditionEvalError", () => {
    expect(() =>
      evaluateCondition(
        { field: "entity:n1.val", op: "matches", value: "abc" },
        nodeSet("a".repeat(MAX_MATCH_SUBJECT + 1))
      )
    ).toThrow(ConditionEvalError);
  });

  it("surfaces an unsupported pattern as ConditionEvalError", () => {
    expect(() =>
      evaluateCondition(
        { field: "entity:n1.val", op: "matches", value: "(.)\\1" },
        nodeSet("aa")
      )
    ).toThrow(ConditionEvalError);
  });
});
