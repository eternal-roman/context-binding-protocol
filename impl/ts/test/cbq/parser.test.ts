import { describe, it, expect } from "vitest";
import { parseCbq, CbqParseError } from "../../src/cbq/parser.js";

describe("CBQ parser (G6)", () => {
  describe("weight predicates", () => {
    it("parses w>0.5", () => {
      const q = parseCbq("w>0.5");
      expect(q.predicates).toEqual([{ kind: "weight", op: ">", value: 0.5 }]);
    });

    it("parses w>=0.9", () => {
      const q = parseCbq("w>=0.9");
      expect(q.predicates).toEqual([{ kind: "weight", op: ">=", value: 0.9 }]);
    });

    it("parses w<0.3", () => {
      const q = parseCbq("w<0.3");
      expect(q.predicates).toEqual([{ kind: "weight", op: "<", value: 0.3 }]);
    });

    it("parses w<=1.0", () => {
      const q = parseCbq("w<=1.0");
      expect(q.predicates).toEqual([{ kind: "weight", op: "<=", value: 1.0 }]);
    });

    it("parses w=0.5", () => {
      const q = parseCbq("w=0.5");
      expect(q.predicates).toEqual([{ kind: "weight", op: "=", value: 0.5 }]);
    });

    it("parses w!=0", () => {
      const q = parseCbq("w!=0");
      expect(q.predicates).toEqual([{ kind: "weight", op: "!=", value: 0 }]);
    });

    it("throws on invalid number", () => {
      expect(() => parseCbq("w>abc")).toThrow(CbqParseError);
    });

    it("throws on missing operator", () => {
      expect(() => parseCbq("w0.5")).toThrow(CbqParseError);
    });
  });

  describe("tag predicates", () => {
    it("parses tag:renewal", () => {
      const q = parseCbq("tag:renewal");
      expect(q.predicates).toEqual([{ kind: "tag", tag: "renewal" }]);
    });

    it("parses tag:domain:accounts (colon in tag value)", () => {
      const q = parseCbq("tag:domain:accounts");
      expect(q.predicates).toEqual([{ kind: "tag", tag: "domain:accounts" }]);
    });

    it("throws on empty tag", () => {
      expect(() => parseCbq("tag:")).toThrow(CbqParseError);
    });
  });

  describe("type predicates", () => {
    it("parses type:entity", () => {
      const q = parseCbq("type:entity");
      expect(q.predicates).toEqual([{ kind: "type", nodeType: "entity" }]);
    });

    it("parses all canonical node types", () => {
      for (const t of ["entity", "state", "prior", "frame"]) {
        const q = parseCbq(`type:${t}`);
        expect(q.predicates[0]).toEqual({ kind: "type", nodeType: t });
      }
    });

    it("rejects the removed 'relation' node type", () => {
      // `relation` was removed from NodeType; it must no longer parse.
      expect(() => parseCbq("type:relation")).toThrow(CbqParseError);
    });

    it("throws on invalid type", () => {
      expect(() => parseCbq("type:invalid")).toThrow(CbqParseError);
    });
  });

  describe("root predicates", () => {
    it("parses root:a7c3f1e2", () => {
      const q = parseCbq("root:a7c3f1e2");
      expect(q.predicates).toEqual([{ kind: "root", nodeId: "a7c3f1e2" }]);
    });

    it("parses root with human-readable id (frame ids)", () => {
      const q = parseCbq("root:Acme");
      expect(q.predicates).toEqual([{ kind: "root", nodeId: "Acme" }]);
    });
  });

  describe("depth predicates", () => {
    it("parses depth:2", () => {
      const q = parseCbq("depth:2");
      expect(q.predicates).toEqual([{ kind: "depth", value: 2 }]);
    });

    it("throws on non-integer", () => {
      expect(() => parseCbq("depth:2.5")).toThrow(CbqParseError);
    });

    it("throws on negative", () => {
      expect(() => parseCbq("depth:-1")).toThrow(CbqParseError);
    });
  });

  describe("edges predicates", () => {
    it("parses edges:active", () => {
      const q = parseCbq("edges:active");
      expect(q.predicates).toEqual([{ kind: "edges", filter: "active" }]);
    });

    it("parses edges:all", () => {
      const q = parseCbq("edges:all");
      expect(q.predicates).toEqual([{ kind: "edges", filter: "all" }]);
    });

    it("parses edges:dormant", () => {
      const q = parseCbq("edges:dormant");
      expect(q.predicates).toEqual([{ kind: "edges", filter: "dormant" }]);
    });

    it("throws on invalid filter", () => {
      expect(() => parseCbq("edges:invalid")).toThrow(CbqParseError);
    });
  });

  describe("id predicates", () => {
    it("parses id:a7c3f1e2", () => {
      const q = parseCbq("id:a7c3f1e2");
      expect(q.predicates).toEqual([{ kind: "id", nodeId: "a7c3f1e2" }]);
    });
  });

  describe("combined queries", () => {
    it("parses multiple comma-separated predicates", () => {
      const q = parseCbq("w>0.5,tag:renewal,edges:active");
      expect(q.predicates).toHaveLength(3);
      expect(q.predicates[0]).toEqual({ kind: "weight", op: ">", value: 0.5 });
      expect(q.predicates[1]).toEqual({ kind: "tag", tag: "renewal" });
      expect(q.predicates[2]).toEqual({ kind: "edges", filter: "active" });
    });

    it("parses the v0.1 spec example: root:Acme,depth:2,edges:active", () => {
      const q = parseCbq("root:Acme,depth:2,edges:active");
      expect(q.predicates).toEqual([
        { kind: "root", nodeId: "Acme" },
        { kind: "depth", value: 2 },
        { kind: "edges", filter: "active" },
      ]);
    });

    it("handles whitespace around commas", () => {
      const q = parseCbq("w>0.5 , tag:renewal");
      expect(q.predicates).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("returns empty predicates for empty string", () => {
      const q = parseCbq("");
      expect(q.predicates).toEqual([]);
    });

    it("returns empty predicates for whitespace-only string", () => {
      const q = parseCbq("   ");
      expect(q.predicates).toEqual([]);
    });

    it("throws on unknown prefix", () => {
      expect(() => parseCbq("foo:bar")).toThrow(CbqParseError);
    });

    it("throws on bare word without colon or operator", () => {
      expect(() => parseCbq("something")).toThrow(CbqParseError);
    });
  });
});
