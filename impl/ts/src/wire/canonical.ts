/**
 * JSON Canonical Form (RFC 8785) serializer.
 *
 * Produces deterministic, byte-identical JSON output regardless of
 * property insertion order. Required for:
 * - BLAKE3 id derivation (G1): content-addressable identity
 * - Conformance testing: byte-for-byte comparison across implementations
 * - Future signature verification (v1.0+)
 *
 * @see spec/wire-format.md
 * @see https://www.rfc-editor.org/rfc/rfc8785
 */

/**
 * Maximum nesting depth canonicalize() will descend before throwing. The
 * serializer is recursive, so an adversarially deep value (reachable from
 * a node `val`) would otherwise overflow the call stack with an
 * un-catchable RangeError. 64 comfortably exceeds any legitimate CBP
 * payload while staying far below the native stack limit.
 */
export const MAX_CANONICAL_DEPTH = 64;

/**
 * Thrown when a value cannot be canonicalized — currently when it nests
 * beyond {@link MAX_CANONICAL_DEPTH}. A typed error so callers (e.g. REST
 * write routes) can map it to a 400 instead of crashing.
 */
export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizeError";
  }
}

/**
 * Serialize a value to JSON Canonical Form (RFC 8785).
 *
 * Rules:
 * 1. Object keys are sorted by UTF-16 code unit (RFC 8785 §3.2.3 — NOT
 *    Unicode code point; the two differ for characters outside the BMP).
 * 2. Numbers are normalized: no trailing zeros, no leading zeros,
 *    no positive sign, no -0 (rendered as 0).
 * 3. Strings use minimal escaping: only control characters, backslash,
 *    and double-quote are escaped. No unnecessary \uXXXX for printable chars.
 * 4. No whitespace outside strings.
 * 5. null, true, false are literal.
 *
 * @throws CanonicalizeError if the value nests beyond MAX_CANONICAL_DEPTH.
 */
export function canonicalize(value: unknown): string {
  return serializeValue(value, 0);
}

function serializeValue(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizeError(
      `value nests deeper than the maximum of ${MAX_CANONICAL_DEPTH}`
    );
  }
  if (value === null) return "null";
  if (value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object":
      if (Array.isArray(value)) return serializeArray(value, depth);
      return serializeObject(value as Record<string, unknown>, depth);
    default:
      throw new Error(`Cannot canonicalize value of type ${typeof value}`);
  }
}

/**
 * RFC 8785 number serialization.
 *
 * Uses JSON.stringify for standard cases (it already handles
 * no-trailing-zeros and scientific notation for large/small numbers).
 * Special cases: NaN and Infinity are not valid JSON — throw.
 * -0 is rendered as 0.
 */
function serializeNumber(n: number): string {
  if (!isFinite(n)) {
    throw new Error(`Cannot canonicalize non-finite number: ${n}`);
  }
  // -0 → 0
  if (Object.is(n, -0)) return "0";
  return JSON.stringify(n);
}

/**
 * RFC 8785 string serialization.
 *
 * Control characters (U+0000–U+001F) are escaped as \uXXXX.
 * Backslash and double-quote are escaped.
 * All other characters are passed through unescaped (including
 * non-ASCII / multi-byte UTF-8).
 */
function serializeString(s: string): string {
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x08) {
      result += "\\b";
    } else if (code === 0x09) {
      result += "\\t";
    } else if (code === 0x0a) {
      result += "\\n";
    } else if (code === 0x0c) {
      result += "\\f";
    } else if (code === 0x0d) {
      result += "\\r";
    } else if (code === 0x22) {
      result += '\\"';
    } else if (code === 0x5c) {
      result += "\\\\";
    } else if (code < 0x20) {
      result += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      result += s[i];
    }
  }
  result += '"';
  return result;
}

function serializeArray(arr: unknown[], depth: number): string {
  const items = arr.map((item) => serializeValue(item, depth + 1));
  return "[" + items.join(",") + "]";
}

/**
 * RFC 8785 object serialization.
 *
 * Keys are sorted by UTF-16 code unit value (RFC 8785 §3.2.3): "Property
 * name strings to be sorted are formatted as arrays of UTF-16 code units
 * ... treated as unsigned integers." Array.prototype.sort()'s default
 * string comparison is exactly UTF-16-code-unit order, so it is the
 * correct primitive here. This intentionally differs from Unicode
 * code-point order for characters outside the BMP (e.g. emoji); see the
 * canonical-form conformance test that pins this behavior.
 */
function serializeObject(obj: Record<string, unknown>, depth: number): string {
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const pairs = keys.map(
    (key) => serializeString(key) + ":" + serializeValue(obj[key], depth + 1)
  );
  return "{" + pairs.join(",") + "}";
}
