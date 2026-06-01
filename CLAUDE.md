# Guidance for AI coding assistants

This repository is an experimental, MIT-licensed personal project. The full
working conventions are in [AGENTS.md](./AGENTS.md); [README.md](./README.md)
describes what the project is.

Short version:

- The TypeScript reference implementation is in `impl/ts` — build, test, and lint
  from there (`pnpm test`, `pnpm typecheck`, `pnpm lint`).
- `cbp-architecture.html` is the design reference; `spec/` holds the schemas,
  grammar, wire format, and conformance vectors the implementation validates
  against.
- This project claims no novelty over prior art. Keep documentation factual and
  verified — do not add benchmarks, metrics, or capability claims the code does
  not actually demonstrate. If something is untrue, non-functioning, or unused,
  remove it.
- Do not reintroduce the proprietary / governance / federation framing that was
  deliberately removed when this was open-sourced.
