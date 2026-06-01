# CBP — TypeScript reference implementation

The reference implementation of [CBP](../../README.md). Requires Node ≥ 20 and
[pnpm](https://pnpm.io). Everything below is dependency-free and key-free unless
noted.

```bash
pnpm install
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm demo` | Dependency-free quickstart: stores facts and recalls them (below). |
| `pnpm start` | Runs the REST server (env: `PORT`=3000, `HOST`=127.0.0.1, `CBP_TOKEN`). |
| `pnpm dev` | Same server under `tsx watch`. |
| `pnpm test` | Vitest suite. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm lint` | ESLint over `src/` and `test/`. |
| `pnpm conformance` | Runs the conformance vectors in `test/conformance/`. |
| `pnpm build` | Emits `dist/`. |

## Library quickstart (in-process SDK)

```ts
import { CbpClient } from "./src/sdk/client.js";
import { FrameConfig } from "./src/types/frame.js";

const frameConfig = FrameConfig.parse({
  id: "onboarding",
  root_weight: 1,
  root_decay: "none",
  max_token_budget: 2000,
  inheritance_mode: "prototypal",
});
const client = new CbpClient({ frameConfig, writeAccess: true });

await client.ingest([
  { type: "entity", val: "Priya Nair is the on-call lead for deployment and outage incidents.", w: 0.9, tags: [] },
  { type: "state", val: "Postgres database backups run nightly and are retained for thirty days.", w: 0.8, tags: [] },
]);

const ctx = await client.recall("How long are Postgres database backups retained?", { k: 3 });
console.log(ctx.entries[0]?.text);  // → the backups fact
console.log(ctx.tokensUsed, "/", frameConfig.max_token_budget);
```

`pnpm demo` runs a slightly larger version of this. Its recall output (verbatim):

```
  Q: How long are Postgres database backups retained?
     → [0.570] Postgres database backups run nightly and are retained for thirty days.
     (assembled 3 of 3 matches into 66/2000 tokens)
```

### A note on recall quality

The default embedder (`HashingEmbedder`, `src/memory/embedder.ts`) is a
dependency-free, bag-of-words **lexical** matcher: it ranks by shared words, not
meaning. It is fine for lexical lookup and demos. For semantic recall (matching
paraphrases), implement the small `Embedder` interface with a real embedding
model and inject it. No embedding model ships with this library.

## REST server

```bash
pnpm start        # listens on http://127.0.0.1:3000
```

All `/v1` routes require a bearer token; `/healthz` does not. With the default
dev token:

```bash
curl http://127.0.0.1:3000/healthz
# {"status":"ok","uptime_s":7,"version":"0.13.0","frames":1}

curl -H "Authorization: Bearer dev-token" http://127.0.0.1:3000/v1/frames
# {"frames":["demo"]}

curl -H "Authorization: Bearer dev-token" "http://127.0.0.1:3000/v1/frame/demo?tier=full"
# {"edges":[],"frame":{"id":"demo",...},"nodes":[],"tier":"full","v":1}

curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/v1/frames
# 401   (no bearer token)
```

`CBP_TOKEN` defaults to the insecure literal `dev-token` and logs a warning; set
it before any real use. The full endpoint surface is documented in
[`cbp-architecture.html`](../../cbp-architecture.html) §IX.

## Layout

```
src/
  types/        node, edge, frame, config schemas (zod)
  wire/         RFC 8785 canonical JSON
  graph/        content-addressed store, persistence
  resolver/     inheritance + conditional-edge evaluation
  serializer/   three-tier serialization under a token budget
  router/       tier negotiation
  decay/        epoch/event decay + GC
  cbq/          query parser
  memory/       projection, in-memory index, HashingEmbedder
  ingest/       fact + document ingestion, entity tagging
  recall/       embed → rank → assemble-to-budget; optional graph retriever
  rest/         Fastify REST server
  ws/           WebSocket mutation stream
  sdk/          in-process client (CbpClient)
  main.ts       runnable server entry
test/           vitest suite, incl. test/conformance/
demo/           dependency-free quickstart
```

The normative schemas, CBQ grammar, wire format, and conformance vectors live in
[`../../spec`](../../spec); `node ../../.github/scripts/spec-coherence.mjs` (from
the repo root) checks the design doc and schemas agree.

## Status

Experimental and unstable (`v0.x`). Interfaces may change.
