# AGENTS.md

Working conventions for any AI assistant or contributor in this repository.

## What this is

An experimental, MIT-licensed implementation of CBP — a small format and library
for delivering structured, state-conditioned, token-budgeted context to LLMs. It
synthesizes well-known ideas (frame systems, typed property graphs,
content-addressing, conditional rules, context compression) and claims no
novelty. See [README.md](./README.md) and [cbp-architecture.html](./cbp-architecture.html).

## Layout

- `impl/ts/` — the TypeScript reference implementation (all the code).
- `spec/` — JSON Schemas, the CBQ grammar (`cbq.ebnf`), the wire format, and
  conformance vectors the implementation validates against.
- `cbp-architecture.html` — the design reference (open in a browser).

## Build, test, run (from `impl/ts`)

- `pnpm install`
- `pnpm test` — full vitest suite
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint
- `pnpm conformance` — conformance vectors
- `pnpm demo` — dependency-free quickstart
- `pnpm start` — REST server (`PORT`, `HOST`, `CBP_TOKEN` env vars)

From the repo root, `node .github/scripts/spec-coherence.mjs` checks that the
design doc's node/edge types match `spec/schemas/*.json`.

## Conventions

- **Keep documentation factual and verified.** Do not add metrics, benchmarks,
  or capability claims the code does not actually demonstrate. If something is
  untrue, non-functioning, or unused, remove it rather than soften it.
- The default embedder is dependency-free and lexical; real embedders implement
  the `Embedder` interface (`impl/ts/src/memory/embedder.ts`). No embedding model
  ships with the library.
- Node types (`entity`, `state`, `prior`, `frame`) and edge types must stay in
  sync with `spec/schemas/*.json` (the spec-coherence check enforces this).
- Avoid new runtime dependencies without a clear reason — `re2` and the Fastify
  stack are the only non-trivial ones.
- Do not reintroduce proprietary / governance / federation framing; it was
  removed deliberately when the project was open-sourced.
