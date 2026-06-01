# CBP Conformance Test Vectors

**Version:** 0.3
**Status:** Normative
**Spec reference:** `cbp-architecture.html` Section IX

---

## Purpose

This directory contains **language-agnostic test vectors** that every CBP
implementation must pass identically. Vectors are JSON files that define
an input (a frame with nodes and edges), an operation (resolve, serialize,
query), and an expected output. Implementations that produce different
results for the same vector are non-conforming.

## Directory Structure

```
spec/conformance/
├── README.md         # this file
├── accounts/         # B2B SaaS account-health domain vectors
├── clinical/         # clinical decision support vectors
├── devops/           # DevOps / incident response vectors
└── legal/            # legal document analysis vectors
```

**All four domains are required.** CI (`conformance.yml`) fails if any
domain directory is empty. CBP is domain-general (cbp-architecture.html §I);
conformance vectors must prove it.

## Vector Format

Each vector file is a JSON object with this structure:

```json
{
  "vector_id": "accounts-001-basic-inheritance",
  "version": "0.3",
  "domain": "accounts",
  "description": "Basic prototypal inheritance from frame root through entity to state",
  "tags": ["inheritance", "prototypal", "entity", "state"],
  "input": {
    "frame": { /* FrameConfig */ },
    "nodes": [ /* CbpNode[] */ ],
    "edges": [ /* CbpEdge[] */ ]
  },
  "operations": [
    {
      "op": "resolve",
      "description": "Resolve the full frame with all inheritance applied",
      "params": {},
      "expected": {
        "nodes": [ /* resolved nodes with inherited fields filled */ ],
        "edges": [ /* active edges only (conditionals evaluated) */ ]
      }
    },
    {
      "op": "query",
      "description": "CBQ query filtering",
      "params": { "cbq": "w>0.5" },
      "expected": {
        "nodes": [ /* filtered node set */ ]
      }
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `vector_id` | string | yes | Unique identifier: `<domain>-<number>-<slug>` |
| `version` | string | yes | Conformance vector format version |
| `domain` | string | yes | One of: `accounts`, `clinical`, `devops`, `legal` |
| `description` | string | yes | What this vector tests |
| `tags` | string[] | yes | Categorization for selective test runs |
| `input.frame` | FrameConfig | yes | Frame configuration |
| `input.nodes` | CbpNode[] | yes | Nodes in the frame |
| `input.edges` | CbpEdge[] | yes | Edges in the frame |
| `operations` | Operation[] | yes | One or more operations to execute |

### Operation Types

| `op` | Description | `params` | `expected` |
|---|---|---|---|
| `resolve` | Resolve the full frame: apply inheritance, evaluate conditionals | `{}` | `{ nodes, edges }` — fully resolved |
| `query` | Apply a CBQ query to the resolved frame | `{ cbq: "<query>" }` | `{ nodes }` — filtered result |
| `serialize` | Serialize the resolved frame at a given tier | `{ tier: "full"\|"condensed"\|"signal" }` | `{ wire: "<canonical JSON>" }` |
| `id_derive` | Compute the BLAKE3 id for a node from its content fields | `{ node: CbpNode }` | `{ id: "<expected_id>" }` |
| `export_roundtrip` | Assert the frame's `nodes` and `edges` canonicalize (RFC 8785) byte-identically across a serialization round-trip, and that the export shape carries no resolver-computed fields on edges (e.g. `active`). This is the portable canonical-stability invariant; the full REST `/export` → `/import` (fresh store) cycle that depends on it is verified by implementation integration tests (e.g. `impl/ts/test/rest/export-import.test.ts`). Added in v0.5 for persistence interop. | `{}` | `{ roundtrip: "byte_identical", must_not_contain_on_edges?: string[] }` |
| `recall` | Project fixture nodes (HashingEmbedder — a pure function of text, no model download), embed the query string with the same embedder, cosine-rank against the memory store, and assemble ranked records to the token budget. Compare `first_id` (highest-ranked admitted entry), `admitted_ids` (full set of admitted ids, order-insensitive), and `tokens_le_budget` (assembled block fits within `params.budget`). Fully deterministic: the hashing embedder produces identical vectors on every platform. | `{ query: string; dim: number; k?: number; budget: number; minScore?: number }` | `{ first_id?: string; admitted_ids?: string[]; tokens_le_budget?: boolean }` |

### Conventions

1. **Deterministic.** Vectors must be reproducible. No random values, no
   timestamps, no system-dependent data.
2. **Self-contained.** Each vector contains everything needed to execute it.
   No external file references.
3. **Minimal.** Each vector tests one concept (or a small number of related
   concepts). Avoid mega-vectors that test everything at once.
4. **Cross-domain.** Each domain directory must contain at least one vector
   that exercises each core capability: inheritance, conditional edges, and
   CBQ queries.

## Adding Vectors

1. Create a JSON file in the appropriate domain directory.
2. Follow the naming convention: `<number>-<slug>.json` (e.g., `001-basic-inheritance.json`).
3. Include at least one operation in the `operations` array.
4. Run the conformance test suite locally to verify:
   ```bash
   cd impl/ts && pnpm conformance
   ```
5. Add the vector in the same PR as any implementation change it exercises.

## CI Enforcement

`.github/workflows/conformance.yml` runs every vector against every
implementation in `impl/<lang>/`. A vector failure blocks merge. The
workflow checks:

1. Every `.json` file in `spec/conformance/*/` is valid JSON matching the
   vector schema above.
2. Every domain directory is non-empty.
3. Every implementation passes every vector.
