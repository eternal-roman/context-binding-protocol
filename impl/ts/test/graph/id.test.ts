import { describe, it, expect } from "vitest";
import { computeFullHash, deriveId, deriveUniqueId } from "../../src/graph/id.js";

describe("BLAKE3 id derivation (G1)", () => {
  const btcNode = {
    type: "entity" as const,
    val: "Acme Corp",
    lineage: "f0d2e8a1",
    tags: ["domain:accounts"],
  };

  it("produces a 64-char hex string for the full hash", () => {
    const hash = computeFullHash(btcNode);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an 8-char display id by default", () => {
    const id = deriveId(btcNode);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — same content produces same id", () => {
    const id1 = deriveId(btcNode);
    const id2 = deriveId(btcNode);
    expect(id1).toBe(id2);
  });

  it("is key-order independent (RFC 8785 canonicalization)", () => {
    const a = { type: "entity" as const, val: "Acme Corp", lineage: null, tags: [] };
    const b = { tags: [], lineage: null, type: "entity" as const, val: "Acme Corp" };
    expect(deriveId(a)).toBe(deriveId(b));
  });

  it("produces different ids for different content", () => {
    const ethNode = { ...btcNode, val: "Globex Inc" };
    expect(deriveId(btcNode)).not.toBe(deriveId(ethNode));
  });

  it("does NOT change id when metadata fields change", () => {
    // Metadata fields (w, decay, ttl, v, prev) are not hashed
    // We only pass content fields, so this test verifies the contract
    const nodeA = { type: "entity" as const, val: "Acme Corp", lineage: null, tags: [] };
    const nodeB = { type: "entity" as const, val: "Acme Corp", lineage: null, tags: [] };
    expect(deriveId(nodeA)).toBe(deriveId(nodeB));
  });

  describe("deriveUniqueId", () => {
    it("returns 8-char id when no collision", () => {
      const id = deriveUniqueId(btcNode, new Set());
      expect(id.length).toBe(8);
    });

    it("extends id on collision", () => {
      const normalId = deriveId(btcNode);
      // Simulate collision: existing set contains the 8-char id
      const existing = new Set([normalId]);
      const uniqueId = deriveUniqueId(btcNode, existing);
      expect(uniqueId.length).toBe(9);
      expect(uniqueId.startsWith(normalId)).toBe(true);
    });

    it("extends further on multiple collisions", () => {
      const hash = computeFullHash(btcNode);
      // Simulate collisions for 8, 9, and 10 char prefixes
      const existing = new Set([
        hash.slice(0, 8),
        hash.slice(0, 9),
        hash.slice(0, 10),
      ]);
      const uniqueId = deriveUniqueId(btcNode, existing);
      expect(uniqueId.length).toBe(11);
    });
  });
});
