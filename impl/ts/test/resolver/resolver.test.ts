import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFrame, resolveFrameWithQuery } from "../../src/resolver/resolver.js";
import type { FrameInput } from "../../src/resolver/resolver.js";
import { evaluateCondition } from "../../src/resolver/condition-eval.js";

const CONFORMANCE_DIR = join(__dirname, "../../../../spec/conformance");

function loadVector(domain: string, file: string): Record<string, unknown> {
  const path = join(CONFORMANCE_DIR, domain, file);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("Resolver — conformance vectors", () => {
  describe("accounts/001-basic-inheritance", () => {
    const vector = loadVector("accounts", "001-basic-inheritance.json");
    const input = vector.input as FrameInput;
    const ops = vector.operations as Array<Record<string, unknown>>;

    it("resolves frame with inheritance (tags flow from root)", () => {
      const resolved = resolveFrame(input);
      const expectedOp = ops[0];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<Record<string, unknown>>;

      // All nodes should have inherited the domain:accounts tag from frame root
      for (const expectedNode of expectedNodes) {
        const actual = resolved.nodes.find((n) => n.id === expectedNode.id);
        expect(actual).toBeDefined();
        if (expectedNode.tags) {
          expect(actual?.tags).toEqual(
            expect.arrayContaining(expectedNode.tags as string[])
          );
        }
      }
    });

    it("CBQ weight filter: w>0.9 returns frame root + Acme Corp entity + health-score state", () => {
      const expectedOp = ops[1];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<{ id: string }>;
      const expectedIds = expectedNodes.map((n) => n.id).sort();

      const resolved = resolveFrameWithQuery(input, "w>0.9");
      const actualIds = resolved.nodes.map((n) => n.id).sort();

      expect(actualIds).toEqual(expectedIds);
    });
  });

  describe("accounts/002-conditional-edges", () => {
    const vector = loadVector("accounts", "002-conditional-edges.json");
    const input = vector.input as FrameInput;
    const ops = vector.operations as Array<Record<string, unknown>>;

    it("Acme-Globex correlates edge is ACTIVE when renewal_outlook=at_risk", () => {
      const resolved = resolveFrame(input);
      const expectedOp = ops[0];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedEdges = expected.edges as Array<{ id: string; active: boolean }>;

      for (const expectedEdge of expectedEdges) {
        const actual = resolved.edges.find((e) => e.id === expectedEdge.id);
        expect(actual).toBeDefined();
        expect(actual?.active).toBe(expectedEdge.active);
      }
    });

    it("CBQ edges:active returns only active edges", () => {
      const resolved = resolveFrameWithQuery(input, "edges:active");
      const expectedOp = ops[1];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedEdges = expected.edges as Array<{ id: string; active: boolean }>;

      expect(resolved.edges).toHaveLength(expectedEdges.length);
      for (const edge of resolved.edges) {
        expect(edge.active).toBe(true);
      }
    });
  });

  describe("clinical/001-patient-inheritance", () => {
    const vector = loadVector("clinical", "001-patient-inheritance.json");
    const input = vector.input as FrameInput;
    const ops = vector.operations as Array<Record<string, unknown>>;

    it("resolves frame with deep inheritance (clinical tags flow through patient entity)", () => {
      const resolved = resolveFrame(input);
      const expectedOp = ops[0];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<{ id: string; tags: string[] }>;

      for (const expectedNode of expectedNodes) {
        const actual = resolved.nodes.find((n) => n.id === expectedNode.id);
        expect(actual).toBeDefined();
        for (const tag of expectedNode.tags) {
          expect(actual?.tags).toContain(tag);
        }
      }
    });

    it("CBQ type:state returns only state nodes", () => {
      const expectedOp = ops[1];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<{ id: string }>;
      const expectedIds = expectedNodes.map((n) => n.id).sort();

      const resolved = resolveFrameWithQuery(input, "type:state");
      const actualIds = resolved.nodes.map((n) => n.id).sort();

      expect(actualIds).toEqual(expectedIds);
    });
  });

  describe("devops/001-incident-cascade", () => {
    const vector = loadVector("devops", "001-incident-cascade.json");
    const input = vector.input as FrameInput;
    const ops = vector.operations as Array<Record<string, unknown>>;

    it("causes edge is ACTIVE when gateway is degraded", () => {
      const resolved = resolveFrame(input);
      const expectedOp = ops[0];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedEdges = expected.edges as Array<{ id: string; active: boolean }>;

      for (const expectedEdge of expectedEdges) {
        const actual = resolved.edges.find((e) => e.id === expectedEdge.id);
        expect(actual).toBeDefined();
        expect(actual?.active).toBe(expectedEdge.active);
      }
    });

    it("CBQ tag:severity:high returns only high-severity nodes", () => {
      const expectedOp = ops[1];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<{ id: string }>;
      const expectedIds = expectedNodes.map((n) => n.id).sort();

      const resolved = resolveFrameWithQuery(input, "tag:severity:high");
      const actualIds = resolved.nodes.map((n) => n.id).sort();

      expect(actualIds).toEqual(expectedIds);
    });
  });

  describe("legal/001-clause-contradicts", () => {
    const vector = loadVector("legal", "001-clause-contradicts.json");
    const input = vector.input as FrameInput;
    const ops = vector.operations as Array<Record<string, unknown>>;

    it("contradicts edge is ACTIVE when contract value > $1M", () => {
      const resolved = resolveFrame(input);
      const expectedOp = ops[0];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedEdges = expected.edges as Array<{ id: string; active: boolean }>;

      for (const expectedEdge of expectedEdges) {
        const actual = resolved.edges.find((e) => e.id === expectedEdge.id);
        expect(actual).toBeDefined();
        expect(actual?.active).toBe(expectedEdge.active);
      }
    });

    it("CBQ w>=0.85 returns high-weight nodes", () => {
      const expectedOp = ops[1];
      const expected = expectedOp?.expected as Record<string, unknown>;
      const expectedNodes = expected.nodes as Array<{ id: string }>;
      const expectedIds = expectedNodes.map((n) => n.id).sort();

      const resolved = resolveFrameWithQuery(input, "w>=0.85");
      const actualIds = resolved.nodes.map((n) => n.id).sort();

      expect(actualIds).toEqual(expectedIds);
    });
  });
});

describe("Resolver — condition evaluation", () => {
  const nodes = new Map([
    [
      "e5f6a7b8",
      {
        id: "e5f6a7b8",
        type: "prior" as const,
        val: { renewal_outlook: "at_risk" },
        w: 0.6,
        decay: "epoch" as const,
        ttl: 3600,
        lineage: null,
        tags: [],
        v: 1,
        prev: null,
      },
    ],
  ]);

  it("evaluates 'always' as true", () => {
    expect(evaluateCondition("always", nodes)).toBe(true);
  });

  it("evaluates eq leaf correctly", () => {
    const condition = {
      field: "prior:e5f6a7b8.val.renewal_outlook",
      op: "eq" as const,
      value: "at_risk",
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates ne leaf correctly", () => {
    const condition = {
      field: "prior:e5f6a7b8.val.renewal_outlook",
      op: "ne" as const,
      value: "healthy",
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates 'all' (AND)", () => {
    const condition = {
      all: [
        { field: "prior:e5f6a7b8.val.renewal_outlook", op: "eq" as const, value: "at_risk" },
        { field: "prior:e5f6a7b8.w", op: "gt" as const, value: 0.5 },
      ],
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates 'any' (OR)", () => {
    const condition = {
      any: [
        { field: "prior:e5f6a7b8.val.renewal_outlook", op: "eq" as const, value: "healthy" },
        { field: "prior:e5f6a7b8.w", op: "gt" as const, value: 0.5 },
      ],
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates 'not'", () => {
    const condition = {
      not: {
        field: "prior:e5f6a7b8.val.renewal_outlook",
        op: "eq" as const,
        value: "healthy",
      },
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates 'exists' on present field", () => {
    const condition = {
      field: "prior:e5f6a7b8.val.renewal_outlook",
      op: "exists" as const,
    };
    expect(evaluateCondition(condition, nodes)).toBe(true);
  });

  it("evaluates 'exists' on missing field", () => {
    const condition = {
      field: "prior:e5f6a7b8.val.nonexistent",
      op: "exists" as const,
    };
    expect(evaluateCondition(condition, nodes)).toBe(false);
  });

  it("returns false for missing node reference", () => {
    const condition = {
      field: "prior:missing.val.renewal_outlook",
      op: "eq" as const,
      value: "at_risk",
    };
    expect(evaluateCondition(condition, nodes)).toBe(false);
  });
});
