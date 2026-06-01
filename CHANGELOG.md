# Changelog

This project is experimental; pre-1.0 releases are unstable and may change
without notice. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
