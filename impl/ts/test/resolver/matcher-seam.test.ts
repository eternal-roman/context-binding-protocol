/**
 * The `matches` operator's regex engine is an OPT-IN, REGISTERED dependency —
 * `@cbp/core` carries no static `re2` import.
 *
 * `re2` is the one native build dependency (it is in `pnpm.onlyBuiltDependencies`),
 * and it backs exactly one of ten condition operators (`matches`). So the engine
 * is pluggable: `safe-match.ts` owns the security policy (length caps, the
 * `SafeMatchError` type) and a single registered-matcher slot; the RE2 engine
 * lives behind the `Matcher` seam in `matchers/re2-matcher.ts` and is registered
 * by the app (and, for these tests, by the global test setup).
 *
 * These tests pin the seam:
 *   1. with NO matcher registered, `matches` fails CLOSED with an actionable
 *      error that names re2 / registerMatcher (not a confusing crash);
 *   2. with the re2 matcher registered, the feature is fully preserved;
 *   3. an arbitrary `Matcher` can be swapped in (the engine is not hard-wired);
 *   4. the length caps are enforced by the seam BEFORE the engine runs, so the
 *      ReDoS resource bound holds regardless of which engine is plugged in.
 *
 * @see cbp-architecture.html Section III — Conditional Edge Activation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  safeMatch,
  SafeMatchError,
  registerMatcher,
  getMatcher,
  clearMatcher,
  MAX_MATCH_SUBJECT,
  type Matcher,
} from "../../src/resolver/safe-match.js";
import {
  evaluateCondition,
  ConditionEvalError,
} from "../../src/resolver/condition-eval.js";
import { re2Matcher } from "../../src/matchers/re2-matcher.js";
import type { CbpNode } from "../../src/types/node.js";

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

describe("matcher seam — re2 is an opt-in engine, core has no static re2 dep", () => {
  // The global test setup registers the re2 matcher; save and restore it around
  // each test so a test that clears the matcher does not leak into the next.
  let saved: Matcher | null;
  beforeEach(() => {
    saved = getMatcher();
  });
  afterEach(() => {
    clearMatcher();
    if (saved) registerMatcher(saved);
  });

  describe("when no matcher is registered (bare core install)", () => {
    beforeEach(() => clearMatcher());

    it("safeMatch fails closed with an actionable error naming re2 / registerMatcher", () => {
      expect(getMatcher()).toBeNull();
      let err: unknown;
      try {
        safeMatch("^Acme", "Acme Corp");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SafeMatchError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/matcher/i);
      expect(msg).toMatch(/re2|registerMatcher/i);
    });

    it("the matches operator surfaces the missing matcher as ConditionEvalError", () => {
      expect(() =>
        evaluateCondition(
          { field: "entity:n1.val", op: "matches", value: "^Acme" },
          nodeSet("Acme Corp")
        )
      ).toThrow(ConditionEvalError);
    });

    it("every other operator works with no matcher registered (dependency-free)", () => {
      expect(
        evaluateCondition(
          { field: "entity:n1.val", op: "eq", value: "Acme Corp" },
          nodeSet("Acme Corp")
        )
      ).toBe(true);
      expect(
        evaluateCondition(
          { field: "entity:n1.val", op: "contains", value: "Acme" },
          nodeSet("Acme Corp")
        )
      ).toBe(true);
    });
  });

  describe("when the re2 matcher is registered", () => {
    beforeEach(() => registerMatcher(re2Matcher));

    it("getMatcher returns the registered re2 matcher", () => {
      expect(getMatcher()?.name).toBe("re2");
    });

    it("safeMatch evaluates patterns (feature preserved)", () => {
      expect(safeMatch("^Acme", "Acme Corp")).toBe(true);
      expect(safeMatch("^Globex", "Acme Corp")).toBe(false);
    });

    it("the matches operator activates end-to-end", () => {
      expect(
        evaluateCondition(
          { field: "entity:n1.val", op: "matches", value: "(at_risk|healthy)" },
          nodeSet("renewal:at_risk")
        )
      ).toBe(true);
    });

    it("still surfaces an unsupported (backtracking) construct as SafeMatchError", () => {
      expect(() => safeMatch("(.)\\1", "aa")).toThrow(SafeMatchError);
    });
  });

  describe("the engine is pluggable (not hard-wired to re2)", () => {
    it("uses an arbitrary registered Matcher", () => {
      const calls: Array<[string, string]> = [];
      const stub: Matcher = {
        name: "stub",
        test(pattern, subject) {
          calls.push([pattern, subject]);
          return pattern === subject;
        },
      };
      registerMatcher(stub);
      expect(getMatcher()?.name).toBe("stub");
      expect(safeMatch("abc", "abc")).toBe(true);
      expect(safeMatch("abc", "xyz")).toBe(false);
      expect(calls).toEqual([
        ["abc", "abc"],
        ["abc", "xyz"],
      ]);
    });
  });

  describe("length caps are enforced by the seam, before the engine runs", () => {
    it("rejects an over-long subject without invoking the registered engine", () => {
      let engineCalled = false;
      registerMatcher({
        name: "trap",
        test() {
          engineCalled = true;
          return true;
        },
      });
      expect(() =>
        safeMatch("abc", "a".repeat(MAX_MATCH_SUBJECT + 1))
      ).toThrow(SafeMatchError);
      expect(engineCalled).toBe(false);
    });
  });
});
