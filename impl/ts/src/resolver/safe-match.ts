/**
 * ReDoS-safe regex matching for the `matches` conditional operator.
 *
 * The naive `new RegExp(pattern).test(subject)` is vulnerable to
 * catastrophic backtracking: a 6-character pattern like `(a+)+$` against
 * an all-`a` subject runs in exponential time and freezes the event loop.
 * RE2 is a finite-automaton engine that matches in time linear in the
 * subject length and cannot backtrack, so it is immune to ReDoS by
 * construction. The trade-off is that RE2 rejects the features that make
 * backtracking pathological — backreferences and lookaround — which are
 * not part of CBP's conditional-edge use case.
 *
 * This module is the single seam that owns the engine choice. Callers use
 * `safeMatch`; if the native RE2 dependency ever needs to be swapped, only
 * this file changes.
 *
 * @see cbp-architecture.html Section III — Conditional Edge Activation
 * @see https://github.com/google/re2 — linear-time regex semantics
 */

import RE2 from "re2";

/** Max compiled pattern length. Bounds compile cost and surface area. */
export const MAX_MATCH_PATTERN = 200;

/**
 * Max subject length. RE2 is linear in the subject, so this is a resource
 * bound (not a correctness one) that keeps a single match cheap even when
 * an attacker controls the subject via node content.
 */
export const MAX_MATCH_SUBJECT = 4096;

export class SafeMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeMatchError";
  }
}

/**
 * Test whether `subject` matches `pattern` using a linear-time engine.
 *
 * @throws SafeMatchError if the pattern exceeds the length cap, the
 *   subject exceeds the length cap, or the pattern is invalid or uses a
 *   feature RE2 does not support (backreferences, lookaround).
 */
export function safeMatch(pattern: string, subject: string): boolean {
  if (pattern.length > MAX_MATCH_PATTERN) {
    throw new SafeMatchError(
      `'matches' pattern exceeds ${MAX_MATCH_PATTERN} character limit`
    );
  }
  if (subject.length > MAX_MATCH_SUBJECT) {
    throw new SafeMatchError(
      `'matches' subject exceeds ${MAX_MATCH_SUBJECT} character limit`
    );
  }

  let re: RE2;
  try {
    re = new RE2(pattern);
  } catch (err) {
    // RE2 throws on invalid patterns and on constructs it does not support
    // (backreferences, lookaround) — exactly the features that enable
    // catastrophic backtracking in a backtracking engine.
    throw new SafeMatchError(
      `'matches' pattern is not a valid linear-time regex: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return re.test(subject);
}
