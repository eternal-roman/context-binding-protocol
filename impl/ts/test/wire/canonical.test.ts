import { describe, it, expect } from "vitest";
import { canonicalize } from "../../src/wire/canonical.js";

describe("canonicalize (RFC 8785)", () => {
  describe("primitives", () => {
    it("serializes null", () => {
      expect(canonicalize(null)).toBe("null");
    });

    it("serializes true", () => {
      expect(canonicalize(true)).toBe("true");
    });

    it("serializes false", () => {
      expect(canonicalize(false)).toBe("false");
    });

    it("serializes undefined as null", () => {
      expect(canonicalize(undefined)).toBe("null");
    });
  });

  describe("numbers", () => {
    it("serializes integers", () => {
      expect(canonicalize(42)).toBe("42");
    });

    it("serializes zero", () => {
      expect(canonicalize(0)).toBe("0");
    });

    it("serializes negative zero as zero", () => {
      expect(canonicalize(-0)).toBe("0");
    });

    it("serializes decimals without trailing zeros", () => {
      expect(canonicalize(0.5)).toBe("0.5");
    });

    it("serializes negative numbers", () => {
      expect(canonicalize(-42)).toBe("-42");
    });

    it("serializes large numbers", () => {
      expect(canonicalize(1e20)).toBe("100000000000000000000");
    });

    it("serializes small numbers in scientific notation", () => {
      expect(canonicalize(1e-7)).toBe("1e-7");
    });

    it("throws on NaN", () => {
      expect(() => canonicalize(NaN)).toThrow("non-finite");
    });

    it("throws on Infinity", () => {
      expect(() => canonicalize(Infinity)).toThrow("non-finite");
    });

    it("throws on -Infinity", () => {
      expect(() => canonicalize(-Infinity)).toThrow("non-finite");
    });
  });

  describe("strings", () => {
    it("serializes simple strings", () => {
      expect(canonicalize("hello")).toBe('"hello"');
    });

    it("serializes empty string", () => {
      expect(canonicalize("")).toBe('""');
    });

    it("escapes backslash", () => {
      expect(canonicalize("a\\b")).toBe('"a\\\\b"');
    });

    it("escapes double quote", () => {
      expect(canonicalize('a"b')).toBe('"a\\"b"');
    });

    it("escapes newline", () => {
      expect(canonicalize("a\nb")).toBe('"a\\nb"');
    });

    it("escapes tab", () => {
      expect(canonicalize("a\tb")).toBe('"a\\tb"');
    });

    it("escapes control characters as \\uXXXX", () => {
      expect(canonicalize("\x00")).toBe('"\\u0000"');
      expect(canonicalize("\x1f")).toBe('"\\u001f"');
    });

    it("does not escape non-ASCII printable characters", () => {
      expect(canonicalize("café")).toBe('"café"');
      expect(canonicalize("日本語")).toBe('"日本語"');
    });
  });

  describe("arrays", () => {
    it("serializes empty array", () => {
      expect(canonicalize([])).toBe("[]");
    });

    it("serializes array with mixed types", () => {
      expect(canonicalize([1, "two", true, null])).toBe('[1,"two",true,null]');
    });

    it("serializes nested arrays", () => {
      expect(canonicalize([[1, 2], [3]])).toBe("[[1,2],[3]]");
    });
  });

  describe("objects", () => {
    it("serializes empty object", () => {
      expect(canonicalize({})).toBe("{}");
    });

    it("sorts keys lexicographically", () => {
      expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });

    it("sorts keys by code unit value (BMP)", () => {
      // "Z" (U+005A) < "a" (U+0061)
      expect(canonicalize({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
    });

    it("sorts keys by UTF-16 code unit, not code point (RFC 8785 §3.2.3)", () => {
      // U+FFFF (BMP, code unit 0xFFFF = 65535) vs U+1F600 😀 (surrogate pair,
      // leading code unit 0xD83D = 55357). RFC 8785 sorts by UTF-16 code
      // unit, so 0xD83D < 0xFFFF → the emoji key sorts FIRST. Under (wrong)
      // code-point ordering it would sort last (0x1F600 > 0xFFFF). This test
      // pins the RFC-mandated behavior so content-addressed ids stay
      // byte-identical across conformant implementations.
      const out = canonicalize({ "￿": 1, "😀": 2 });
      expect(out.indexOf("😀")).toBeLessThan(out.indexOf("￿"));
    });

    it("handles nested objects with sorted keys", () => {
      const obj = { z: { b: 2, a: 1 }, a: 3 };
      expect(canonicalize(obj)).toBe('{"a":3,"z":{"a":1,"b":2}}');
    });

    it("produces no whitespace", () => {
      const result = canonicalize({ key: "value", num: 42 });
      expect(result).not.toMatch(/\s/);
    });
  });

  describe("undefined handling (CBP-003)", () => {
    it("omits object properties with undefined values", () => {
      expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it("omits leading undefined properties from objects", () => {
      expect(canonicalize({ a: undefined, b: 2 })).toBe('{"b":2}');
    });

    it("treats undefined in arrays as null (standard JSON behavior)", () => {
      expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
    });

    it("strips undefined from nested objects", () => {
      expect(canonicalize({ a: { b: undefined, c: 1 } })).toBe(
        '{"a":{"c":1}}'
      );
    });
  });

  describe("CBP-specific round-trips", () => {
    it("canonicalizes a CBP node", () => {
      const node = {
        id: "a7c3f1e2",
        type: "entity",
        val: "BTC",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: "f0d2e8a1",
        tags: ["domain:trading", "asset:crypto"],
        v: 1,
        prev: null,
      };
      const result = canonicalize(node);
      // Keys must be sorted
      expect(result).toBe(
        '{"decay":"epoch","id":"a7c3f1e2","lineage":"f0d2e8a1","prev":null,"tags":["domain:trading","asset:crypto"],"ttl":null,"type":"entity","v":1,"val":"BTC","w":0.9}'
      );
    });

    it("produces identical output regardless of input key order", () => {
      const a = { type: "entity", val: "BTC", lineage: null, tags: [] };
      const b = { tags: [], lineage: null, type: "entity", val: "BTC" };
      expect(canonicalize(a)).toBe(canonicalize(b));
    });
  });
});
