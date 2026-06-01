/**
 * ReDoS-safe regex matching for the `matches` conditional operator.
 *
 * The naive `new RegExp(pattern).test(subject)` is vulnerable to catastrophic
 * backtracking: a 6-character pattern like `(a+)+$` against an all-`a` subject
 * runs in exponential time and freezes the event loop. A linear-time,
 * non-backtracking engine (e.g. RE2) is immune to ReDoS by construction.
 *
 * This module is the single seam that owns the matching *policy* — the
 * pattern/subject length caps and the `SafeMatchError` type — plus a single
 * registered-engine slot. It deliberately does NOT import a regex engine: the
 * engine is the implementation's one native build dependency (`re2`, listed in
 * `pnpm.onlyBuiltDependencies`) and it backs exactly one of ten condition
 * operators, so it is OPT-IN. The app (and the test/conformance harness)
 * register an engine via `registerMatcher`; the reference RE2 engine lives in
 * `matchers/re2-matcher.ts` — the single file that imports `re2`. With no
 * engine registered, `matches` fails CLOSED with an actionable error, while
 * every other operator (`eq/ne/lt/lte/gt/gte/in/contains/exists`) works with
 * no native dependency at all.
 *
 * @see cbp-architecture.html Section III — Conditional Edge Activation
 * @see matchers/re2-matcher.ts — reference linear-time engine (opt-in)
 */

/** Max compiled pattern length. Bounds compile cost and surface area. */
export const MAX_MATCH_PATTERN = 200;

/**
 * Max subject length. A linear-time engine is linear in the subject, so this is
 * a resource bound (not a correctness one) that keeps a single match cheap even
 * when an attacker controls the subject via node content. It is enforced by
 * this seam BEFORE the engine runs, so the bound holds regardless of engine.
 */
export const MAX_MATCH_SUBJECT = 4096;

export class SafeMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeMatchError";
  }
}

/**
 * A pluggable regex engine for the `matches` operator. Implementations MUST use
 * a linear-time, non-backtracking algorithm (no catastrophic backtracking) and
 * SHOULD reject backtracking-enabling constructs (backreferences, lookaround).
 * `test` may throw on an invalid/unsupported pattern; `safeMatch` surfaces that
 * throw as a `SafeMatchError`.
 */
export interface Matcher {
  readonly name: string;
  test(pattern: string, subject: string): boolean;
}

/**
 * Single active engine. Unlike tokenizers, the frame config does not select a
 * matcher by name — there is one regex-engine policy per process — so a single
 * slot is the right shape. `null` means no engine is registered, in which case
 * `matches` fails closed.
 */
let activeMatcher: Matcher | null = null;

/** Register the regex engine used by the `matches` operator. */
export function registerMatcher(matcher: Matcher): void {
  activeMatcher = matcher;
}

/** The currently registered engine, or `null` if none is registered. */
export function getMatcher(): Matcher | null {
  return activeMatcher;
}

/** Unregister the active engine. Primarily for tests. */
export function clearMatcher(): void {
  activeMatcher = null;
}

/**
 * Test whether `subject` matches `pattern` using the registered linear-time
 * engine.
 *
 * @throws SafeMatchError if no engine is registered, the pattern or subject
 *   exceeds its length cap, or the pattern is invalid / uses a construct the
 *   engine does not support.
 */
export function safeMatch(pattern: string, subject: string): boolean {
  const matcher = activeMatcher;
  if (!matcher) {
    throw new SafeMatchError(
      "'matches' operator requires a regex matcher, but none is registered. " +
        "Install the optional native dependency 're2' and register the reference " +
        "engine via registerMatcher(re2Matcher) (from the matchers/re2-matcher " +
        "module), or register your own linear-time Matcher. Every other condition " +
        "operator works without a matcher."
    );
  }
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

  try {
    return matcher.test(pattern, subject);
  } catch (err) {
    // A linear-time engine throws on invalid patterns and on constructs it does
    // not support (backreferences, lookaround) — exactly the features that
    // enable catastrophic backtracking in a backtracking engine.
    throw new SafeMatchError(
      `'matches' pattern is not a valid linear-time regex: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
