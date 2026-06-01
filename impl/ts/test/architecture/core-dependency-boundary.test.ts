/**
 * Architecture boundary: the core primitives carry NO static `re2` dependency.
 *
 * `re2` is the implementation's one native build dependency (it is in
 * `package.json` `pnpm.onlyBuiltDependencies`) and it backs exactly one of ten
 * condition operators (`matches`). Phase 1 of productionization makes it an
 * OPT-IN, registered engine so a consumer who pulls only the core primitives
 * (`@cbp/core`: wire / graph / types / tokenizer / resolver / cbq / serializer)
 * never has to compile a native regex engine.
 *
 * This guard enforces the invariant in CI: `re2` may be imported from EXACTLY
 * ONE file — the opt-in engine seam `matchers/re2-matcher.ts` — and never from
 * any core module directory. Before Phase 1, `resolver/safe-match.ts` imported
 * `re2` directly and would have failed this test; that is its RED state.
 *
 * @see resolver/safe-match.ts — engine-agnostic policy + registry
 * @see matchers/re2-matcher.ts — the single re2 importer (opt-in)
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Module directories that constitute `@cbp/core` (per the productionization design §6). */
const CORE_DIRS = [
  "wire",
  "graph",
  "types",
  "tokenizer",
  "resolver",
  "cbq",
  "serializer",
];

/**
 * Any import/require of the bare `re2` specifier — static (`from "re2"`),
 * side-effect (`import "re2"`), dynamic (`import("re2")`), or CJS
 * (`require("re2")`). The import-context prefixes mean a plain string mention
 * (e.g. the "install 're2'" hint in safe-match.ts's error message) is NOT a
 * false positive, while a relative path like "../matchers/re2-matcher.js"
 * (specifier does not start with `re2`) is also excluded.
 */
const RE2_IMPORT = /(?:from\s*|require\(\s*|import\s*\(\s*|import\s+)["']re2["']/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsRe2(file: string): boolean {
  return RE2_IMPORT.test(readFileSync(file, "utf-8"));
}

describe("core dependency boundary — re2 is a single opt-in seam", () => {
  it("re2 is imported from exactly one file: matchers/re2-matcher.ts", () => {
    const importers = tsFilesUnder(SRC_ROOT)
      .filter(importsRe2)
      .map((f) => relative(SRC_ROOT, f).split(sep).join("/"))
      .sort();
    expect(importers).toEqual(["matchers/re2-matcher.ts"]);
  });

  it("no core module directory imports re2 (zero native dep in @cbp/core)", () => {
    const offenders: string[] = [];
    for (const coreDir of CORE_DIRS) {
      for (const file of tsFilesUnder(join(SRC_ROOT, coreDir))) {
        if (importsRe2(file)) {
          offenders.push(relative(SRC_ROOT, file).split(sep).join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
