# Changelog

This project is experimental; pre-1.0 releases are unstable and may change
without notice. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.13.1] - 2026-06-01

### Added
- **Pluggable regex-matcher seam for the `matches` condition operator.** The
  matching policy (pattern/subject length caps, `SafeMatchError`) and a single
  registered-engine slot now live in `resolver/safe-match.ts`, which no longer
  imports a regex engine. The reference RE2 engine moved to
  `matchers/re2-matcher.ts` — the single module that imports the native `re2`
  dependency — registered as an opt-in. This decouples the core primitives from
  the one native build dependency (CI-enforced: a new architecture test asserts
  `re2` is imported from exactly one file and from no core module directory) and
  lets callers register their own linear-time matcher.

### Changed
- **`matches` now requires a registered engine.** The REST server
  (`createCbpServer`) registers the RE2 engine automatically, so REST/HTTP usage
  is unchanged. Direct consumers of the resolver/serializer primitives (and the
  in-process SDK) that use the `matches` operator must now register an engine
  (`registerMatcher(re2Matcher)`); with none registered, `matches` fails closed
  with an actionable error instead of relying on a static native import. Every
  other operator (`eq/ne/lt/lte/gt/gte/in/contains/exists`) is unaffected and
  needs no native dependency.

## [0.13.0]

### Changed
- **Open-sourced under MIT.** Removed the prior private/proprietary license and
  the governance, provenance, federation, security-policy, and audit documents
  that framed this as a proprietary specification. This is now a plain personal
  open-source project that claims no novelty over prior art.
- **Pruned to a clean core.** Removed a competitive benchmark harness, research
  and evaluation demos, an agent "dogfood" harness, internal design proposals,
  and unmerged embedder/reranker experiments — none of which were essential to
  the working library. Removed the corresponding governance/DCO CI workflows.
- **Made it runnable.** Added `pnpm start` (a REST server entry) and `pnpm demo`
  (a dependency-free quickstart), plus implementation and project READMEs.
- **Documentation rewritten to be factual.** Removed unverified metrics and
  novelty/differentiation claims from the design reference; descriptions now
  cover only what the implementation demonstrably does.

### Removed
- Removed the `@huggingface/transformers` dev-dependency (only the deleted
  experiments used it).

## Earlier history

Earlier versions were developed in a private repository under a proprietary
framing. That detailed changelog was removed as part of open-sourcing; the git
history remains the record of how the code got here.
