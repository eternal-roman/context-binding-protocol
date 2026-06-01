# Context Binding Protocol (CBP)

> An experimental, MIT-licensed format and TypeScript reference library for
> delivering structured, state-conditioned, token-budgeted context to LLMs.

CBP assembles well-established ideas — frame systems, typed property graphs,
content-addressed identity, conditional rules, and context compression — into
one small, coherent library. It does **not** claim novelty over prior art
(knowledge graphs, RAG, MCP, rules engines). It is a personal project: useful as
a working artifact and a study of how those pieces fit together for LLM context
delivery, nothing more.

## What it actually does

- **A typed context graph** — four node types (`entity`, `state`, `prior`,
  `frame`), eight edge types, content-addressed ids (BLAKE3 over the content
  fields).
- **Inheritance** — a child node inherits its parent's fields unless it overrides
  them, resolving up to a `frame` root.
- **Conditional edges** — an edge can carry a condition over node state; when the
  condition is false the edge is omitted from serialization.
- **Three serialization tiers** (`full` / `condensed` / `signal`) packed into a
  token budget — the serializer prunes or drops a tier rather than overflow it.
- **A recall seam** — ingest structured facts, embed them, and recall the top
  matches assembled into a token budget. The default embedder is dependency-free
  and **lexical** (bag-of-words); implement the `Embedder` interface for semantic
  recall.
- **A REST API and an in-process SDK** over all of the above.

The design reference is [`cbp-architecture.html`](./cbp-architecture.html) (open
it in a browser). The artifacts it points at live in [`spec/`](./spec): JSON
Schemas, the CBQ grammar (`cbq.ebnf`), the wire format, and conformance vectors
the implementation is tested against.

## Quickstart

The reference implementation is TypeScript, in [`impl/ts`](./impl/ts). Requires
Node ≥ 20 and [pnpm](https://pnpm.io).

```bash
cd impl/ts
pnpm install
pnpm demo      # dependency-free: store facts, recall them, assemble to a budget
pnpm start     # REST server on http://127.0.0.1:3000 (set CBP_TOKEN for real use)
pnpm test      # the test suite
```

See [`impl/ts/README.md`](./impl/ts/README.md) for the library API, the REST
surface, and configuration.

## Status

Experimental and unstable (`v0.x`); interfaces may change and it is not
maintained as a product. Provided as-is.

## License

[MIT](./LICENSE). Third-party dependencies retain their own licenses.
