# CBP Wire Format Specification

**Version:** 0.2
**Status:** Normative
**Spec reference:** `cbp-architecture.html` Section IV (Serialization Tiers)

---

## 1. Normative Wire Format

The canonical wire format for all CBP serialization is **JSON Canonical Form** as defined by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

RFC 8785 specifies:
- Deterministic key ordering (by UTF-16 code unit value, per RFC 8785 §3.2.3 — this differs from Unicode code-point order for characters outside the Basic Multilingual Plane, e.g. emoji)
- Number normalization (no trailing zeros, no leading zeros, no positive sign)
- String escaping normalization
- No whitespace outside strings

These properties guarantee **byte-identical output for byte-identical inputs** across implementations, which is essential for:
- BLAKE3 id derivation (G1) — content-addressable identity requires deterministic serialization
- Conformance vectors — test vectors can compare wire output byte-for-byte
- Signature verification — future signed frames (v1.0+) require canonical form

## 2. Content-Type Negotiation

Clients request specific tiers via the HTTP `Accept` header or the `tier` URL parameter. Both mechanisms are supported; `tier` parameter takes precedence if both are present.

| Tier | Accept Header | tier Parameter |
|---|---|---|
| Full | `application/cbp+json; tier=full` | `tier=full` |
| Condensed | `application/cbp+json; tier=condensed` | `tier=condensed` |
| Signal | `application/cbp+json; tier=signal` | `tier=signal` |
| Auto (server decides) | `application/cbp+json` | `tier=auto` (or omitted) |

Response `Content-Type` always includes the tier actually delivered:
```
Content-Type: application/cbp+json; tier=condensed
```

## 3. Tier 1 — Full Serialization

Used on first encounter with a frame in a conversation. All fields explicit. Inheritance resolved and shown. Every node carries its complete state.

### Wire example (trading domain)

```json
{"frame":{"id":"crypto_macro","max_token_budget":400,"root_decay":"epoch","root_weight":1.0,"tokenizer":"o200k_base"},"nodes":[{"decay":"epoch","id":"a7c3f1e2","lineage":"f0d2e8a1","prev":null,"tags":["domain:trading","asset:crypto"],"type":"entity","v":1,"val":"BTC","w":0.9},{"decay":"event","id":"b2c4d5e6","lineage":"a7c3f1e2","prev":null,"tags":["domain:trading","metric:price"],"type":"state","v":3,"val":{"price":68420,"timestamp":"2026-04-11T14:30:00Z"},"w":0.9}],"edges":[{"conditional":{"field":"prior:regime.val","op":"eq","value":"risk_on"},"decay":"none","id":"f1a2b3c4","prev":null,"rel":"correlates","src":"a7c3f1e2","strength":0.85,"tgt":"c3d5e6f7","v":1,"w":1.0}],"tier":"full","v":1}
```

### Wire example (clinical domain)

```json
{"frame":{"id":"patient_intake","max_token_budget":600,"root_decay":"none","root_weight":1.0,"tokenizer":"o200k_base"},"nodes":[{"decay":"none","id":"b8d4e2f3","lineage":null,"prev":null,"tags":["domain:clinical","dept:cardiology"],"type":"entity","v":1,"val":{"mrn":"MRN-004821","name":"Patient 4821"},"w":1.0},{"decay":"epoch","id":"d4e5f6a7","lineage":"b8d4e2f3","prev":null,"tags":["domain:clinical","vitals"],"type":"state","v":2,"val":{"bp_diastolic":88,"bp_systolic":142,"hr":92},"w":0.95}],"edges":[],"tier":"full","v":1}
```

### Wire example (DevOps domain)

```json
{"frame":{"id":"incident_blast_radius","max_token_budget":300,"root_decay":"event","root_weight":1.0,"tokenizer":"length_fallback"},"nodes":[{"decay":"event","id":"c9e5f3a4","lineage":"d2f6a0b5","prev":"c9e5f3a3","tags":["domain:devops","severity:high"],"type":"state","v":3,"val":{"latency_p99_ms":2340,"service":"api-gateway","status":"degraded"},"w":0.95}],"edges":[{"conditional":"always","decay":"none","id":"e5f6a7b8","prev":null,"rel":"causes","src":"d2f6a0b5","strength":0.9,"tgt":"c9e5f3a4","v":1,"w":0.9}],"tier":"full","v":1}
```

## 4. Tier 2 — Condensed Serialization

Used on subsequent turns in a conversation that has already received a Full serialization for this frame. Inherited fields omitted. Only overrides and deltas from last Full. Edges summarized by type counts unless individual edges changed.

### Wire structure

```json
{
  "frame": { "id": "<frame_id>" },
  "delta": {
    "nodes_changed": [
      { "id": "<node_id>", "w": 0.85, "v": 4 }
    ],
    "nodes_added": [ /* full node objects for new nodes */ ],
    "nodes_removed": [ "<node_id>" ],
    "edges_changed": [
      { "id": "<edge_id>", "activated": true }
    ],
    "edges_added": [ /* full edge objects */ ],
    "edges_removed": [ "<edge_id>" ]
  },
  "edge_summary": { "correlates": 2, "causes": 1, "requires": 1 },
  "tier": "condensed",
  "base_v": 1,
  "v": 2
}
```

The `base_v` field identifies the Full serialization version this delta is relative to. If the client's last-seen version doesn't match `base_v`, it must request a Full resync.

Typical token reduction: **55–70%** compared to Full tier.

## 5. Tier 3 — Signal Serialization

Used when the LLM has already internalized the frame structure and only needs to know what changed. A fingerprint — compact enough for multi-frame stacking within tight budgets.

### Wire structure

```json
{
  "frame": { "id": "<frame_id>" },
  "nodes": [
    { "id": "a7c3f1e2", "w": 0.9, "trend": "up" },
    { "id": "b8d4e2f3", "w": 1.0, "trend": "stable" },
    { "id": "c9e5f3a4", "w": 0.95, "trend": "down" }
  ],
  "edges": { "correlates": 2, "causes": 1 },
  "tier": "signal",
  "base_v": 1,
  "v": 3
}
```

The `trend` field is one of `"up"`, `"down"`, or `"stable"` — computed by comparing the node's current `w` to its `w` at the last Full serialization.

Typical token count: **~20 tokens** for a 12-node frame.

### Human-readable rendering (non-normative)

The v0.1 spec showed a textual Signal example: `"BTC:0.9↑ ETH:0.8→ SOL:0.6↓ | corr:2 cause:1"`. This is a **human-readable rendering** suitable for display or logging, **not the wire format**. Implementations may produce this as a convenience output, but it is not part of the protocol's serialization contract. The wire format for Signal tier is JSON as shown above.

## 6. Optional Encodings (Non-Normative)

Implementations may additionally support:

- **MessagePack** — binary-compact encoding of the same JSON structure. Useful for high-throughput streaming (WebSocket mode 3) where bandwidth matters more than human readability.
- **CBOR** — another binary encoding, common in IoT contexts.

These are **not normative**. Conformance vectors test only JSON Canonical output. Implementations that support optional encodings must still produce identical JSON Canonical output for conformance testing.

## 7. Envelope Structure

Every serialized CBP payload (regardless of tier) is wrapped in a top-level object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `frame` | object | yes | At minimum `{ "id": "<frame_id>" }`. Full tier includes frame config. |
| `tier` | string | yes | `"full"`, `"condensed"`, or `"signal"` |
| `v` | integer | yes | Frame version counter (increments on any change) |
| `base_v` | integer | condensed/signal only | The Full version this payload is relative to |
| `nodes` | array | tier-dependent | Full: all nodes. Signal: id+w+trend. |
| `edges` | array/object | tier-dependent | Full: all edges. Signal: type counts. |
| `delta` | object | condensed only | Changes since base_v |
| `edge_summary` | object | condensed only | Type counts for unchanged edges |

## 8. Token Budget Enforcement

The serializer **must** respect the frame's `max_token_budget` (invariant #1: token budget is law). If the serialized output exceeds the budget, the serializer applies these steps in order:

1. **Prune lowest-weight nodes** until the payload fits.
2. **Collapse inherited fields** (omit fields that match the parent's value).
3. **Drop to a lower tier** (Full → Condensed → Signal).

The serializer never overflows. If even Signal tier exceeds the budget, the serializer returns an error response rather than delivering an oversized payload.

---

*Wire format — see cbp-architecture.html Section IV. Reference serializer
implementation: impl/ts/src/serializer/.*
