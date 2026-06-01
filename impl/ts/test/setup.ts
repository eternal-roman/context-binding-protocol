/**
 * Global vitest setup.
 *
 * Registers the reference RE2 engine for the `matches` operator so the suite
 * (and the conformance run, which shares this config) executes as a fully-wired
 * app would. The engine is opt-in in production — see `resolver/safe-match.ts`
 * — and `createCbpServer` performs the same registration; this mirrors it for
 * the unit tests that drive the resolver directly.
 *
 * Tests that need to exercise the no-engine-registered path clear and restore
 * the matcher themselves (see `test/resolver/matcher-seam.test.ts`).
 */
import { registerMatcher } from "../src/resolver/safe-match.js";
import { re2Matcher } from "../src/matchers/re2-matcher.js";

registerMatcher(re2Matcher);
