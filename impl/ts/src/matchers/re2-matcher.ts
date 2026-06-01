/**
 * Reference linear-time regex engine for the `matches` operator, backed by RE2.
 *
 * This is the SINGLE file in the implementation that imports `re2` — the one
 * native build dependency (it is in `package.json` `pnpm.onlyBuiltDependencies`).
 * It is OPT-IN: the matching policy, the length caps, and the engine registry
 * all live in `resolver/safe-match.ts`, which has no engine import. The app
 * registers this engine via `registerMatcher` (see `rest/server.ts`), so a
 * consumer of the core primitives who never uses the `matches` operator does
 * not need `re2` installed at all.
 *
 * RE2 is a finite-automaton engine: it matches in time linear in the subject
 * length and cannot backtrack, so it is immune to ReDoS by construction. The
 * trade-off — no backreferences or lookaround — is not part of CBP's
 * conditional-edge use case. RE2 throws when constructing such a pattern;
 * `safeMatch` surfaces that throw as a `SafeMatchError`.
 *
 * @see https://github.com/google/re2 — linear-time regex semantics
 * @see resolver/safe-match.ts — the engine-agnostic policy + registry
 */

import RE2 from "re2";
import type { Matcher } from "../resolver/safe-match.js";

export const re2Matcher: Matcher = {
  name: "re2",
  test(pattern: string, subject: string): boolean {
    return new RE2(pattern).test(subject);
  },
};
