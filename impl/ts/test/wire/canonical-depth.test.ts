/**
 * S4(b) — canonicalize() must guard recursion depth.
 *
 * `canonicalize` walks the value recursively. An adversarially deep `val`
 * (reachable from a node write) would otherwise overflow the call stack
 * with an un-catchable `RangeError`. The fix throws a typed
 * `CanonicalizeError` once a depth bound is exceeded, before recursing
 * deep enough to overflow.
 *
 * @see spec/wire-format.md
 */

import { describe, it, expect } from "vitest";
import {
  canonicalize,
  CanonicalizeError,
  MAX_CANONICAL_DEPTH,
} from "../../src/wire/canonical.js";

function nestObjects(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

function nestArrays(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

describe("canonicalize depth guard (S4)", () => {
  it("canonicalizes structures within the depth limit", () => {
    expect(() => canonicalize(nestObjects(MAX_CANONICAL_DEPTH - 2))).not.toThrow();
  });

  it("throws a typed CanonicalizeError beyond the depth limit (no stack overflow)", () => {
    expect(() => canonicalize(nestObjects(10000))).toThrow(CanonicalizeError);
  });

  it("guards deeply nested arrays too", () => {
    expect(() => canonicalize(nestArrays(10000))).toThrow(CanonicalizeError);
  });

  it("MAX_CANONICAL_DEPTH is a positive bound", () => {
    expect(MAX_CANONICAL_DEPTH).toBeGreaterThan(0);
  });
});
