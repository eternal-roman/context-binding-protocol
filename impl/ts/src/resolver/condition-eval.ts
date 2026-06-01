/**
 * Conditional edge evaluator.
 *
 * Evaluates a Condition against the current graph state to determine
 * whether an edge is active or dormant.
 *
 * @see spec/schemas/edge.schema.json — conditional grammar
 * @see cbp-architecture.html Section III — Conditional Edge Activation
 */

import type { Condition } from "../types/edge.js";
import type { CbpNode } from "../types/node.js";
import { safeMatch } from "./safe-match.js";

export class ConditionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionEvalError";
  }
}

// Bound condition recursion. A maliciously deep all/any/not nest — reachable
// from an untrusted edge body — would otherwise overflow the stack at eval
// time (a stored "poison pill" that crashes every resolveFrame). Mirrors the
// node-`val` depth guard (canonical.ts MAX_CANONICAL_DEPTH). Write-time edge
// validation rejects over-deep conditions earlier; this is the eval backstop
// for edges that arrived via import/hydrate.
const MAX_CONDITION_DEPTH = 64;

/**
 * Evaluate a conditional expression against the current node set.
 *
 * @param condition - The condition to evaluate.
 * @param nodes - All nodes in the frame (for field lookups).
 * @returns true if the edge should be active, false if dormant.
 * @throws ConditionEvalError on type mismatch or unresolvable field.
 */
export function evaluateCondition(
  condition: Condition,
  nodes: ReadonlyMap<string, CbpNode>
): boolean {
  // Fail-closed: an edge activates ONLY when its condition is explicitly
  // true. An INDETERMINATE condition (a referenced field/node is missing)
  // leaves the edge dormant, including under negation.
  return evaluateTri(condition, nodes, 0) === "true";
}

/**
 * Kleene three-valued result. `unknown` means the condition could not be
 * decided because referenced data is absent — distinct from `false`, so
 * that `not(unknown)` stays `unknown` (dormant) rather than flipping to
 * active.
 */
type Tri = "true" | "false" | "unknown";

function evaluateTri(
  condition: Condition,
  nodes: ReadonlyMap<string, CbpNode>,
  depth: number
): Tri {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new ConditionEvalError(
      `Condition nesting exceeds max depth of ${MAX_CONDITION_DEPTH}`
    );
  }
  if (condition === "always") return "true";

  if (typeof condition === "object" && "all" in condition) {
    // AND: any false ⇒ false; else any unknown ⇒ unknown; else true.
    const cond = condition as { all: Condition[] };
    let sawUnknown = false;
    for (const c of cond.all) {
      const r = evaluateTri(c, nodes, depth + 1);
      if (r === "false") return "false";
      if (r === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : "true";
  }
  if (typeof condition === "object" && "any" in condition) {
    // OR: any true ⇒ true; else any unknown ⇒ unknown; else false.
    const cond = condition as { any: Condition[] };
    let sawUnknown = false;
    for (const c of cond.any) {
      const r = evaluateTri(c, nodes, depth + 1);
      if (r === "true") return "true";
      if (r === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : "false";
  }
  if (typeof condition === "object" && "not" in condition) {
    const cond = condition as { not: Condition };
    const r = evaluateTri(cond.not, nodes, depth + 1);
    return r === "true" ? "false" : r === "false" ? "true" : "unknown";
  }

  // Leaf condition
  if (typeof condition === "object" && "field" in condition) {
    return evaluateLeaf(condition, nodes);
  }

  throw new ConditionEvalError(
    `Unrecognized condition shape: ${JSON.stringify(condition)}`
  );
}

interface LeafCondition {
  field: string;
  op: string;
  value?: unknown;
}

function evaluateLeaf(
  leaf: LeafCondition,
  nodes: ReadonlyMap<string, CbpNode>
): Tri {
  const resolved = resolveField(leaf.field, nodes);

  // `exists` is decidable even when the field is absent.
  if (leaf.op === "exists") {
    return resolved !== undefined ? "true" : "false";
  }

  // A missing field/node makes every other comparison indeterminate.
  if (resolved === undefined) {
    return "unknown";
  }

  return compareResolved(leaf.op, resolved, leaf.value) ? "true" : "false";
}

/**
 * Compare a resolved (present) field value against the condition value.
 * Type mismatches throw — they are malformed conditions, not missing data.
 */
function compareResolved(op: string, resolved: unknown, value: unknown): boolean {
  switch (op) {
    // eq/ne are NON-throwing (a cross-type comparison is a DECIDED result, not a
    // malformed-condition error) and use STRUCTURAL equality so an object/array
    // field compares by value, not reference identity — `{renewal_outlook:"x"} eq
    // {renewal_outlook:"x"}` is true. Primitives still compare exactly (no coercion).
    case "eq":
      return deepEqual(resolved, value);
    case "ne":
      return !deepEqual(resolved, value);
    case "lt":
      assertNumeric(op, resolved, value);
      return (resolved as number) < (value as number);
    case "lte":
      assertNumeric(op, resolved, value);
      return (resolved as number) <= (value as number);
    case "gt":
      assertNumeric(op, resolved, value);
      return (resolved as number) > (value as number);
    case "gte":
      assertNumeric(op, resolved, value);
      return (resolved as number) >= (value as number);
    case "in":
      if (!Array.isArray(value)) {
        throw new ConditionEvalError(
          `'in' operator requires array value, got ${typeof value}`
        );
      }
      return value.includes(resolved);
    case "contains":
      if (typeof resolved !== "string") {
        throw new ConditionEvalError(
          `'contains' operator requires string field, got ${typeof resolved}`
        );
      }
      if (typeof value !== "string") {
        throw new ConditionEvalError(
          `'contains' operator requires string value, got ${typeof value}`
        );
      }
      return resolved.includes(value);
    case "matches":
      if (typeof resolved !== "string") {
        throw new ConditionEvalError(
          `'matches' operator requires string field, got ${typeof resolved}`
        );
      }
      if (typeof value !== "string") {
        throw new ConditionEvalError(
          `'matches' operator requires string pattern, got ${typeof value}`
        );
      }
      // ReDoS-safe matching (S2): delegate to the linear-time RE2-backed
      // engine. safeMatch enforces pattern/subject length caps and rejects
      // backtracking-enabling constructs; surface its failures as the
      // operator-level error type.
      try {
        return safeMatch(value, resolved);
      } catch (err) {
        throw new ConditionEvalError(
          err instanceof Error ? err.message : String(err)
        );
      }
    default:
      throw new ConditionEvalError(`Unknown operator: "${op}"`);
  }
}

function assertNumeric(op: string, field: unknown, value: unknown): void {
  if (typeof field !== "number") {
    throw new ConditionEvalError(
      `'${op}' operator: field resolved to ${typeof field}, expected number (strict typing — no implicit coercion)`
    );
  }
  if (typeof value !== "number") {
    throw new ConditionEvalError(
      `'${op}' operator: comparison value is ${typeof value}, expected number (strict typing — no implicit coercion)`
    );
  }
}

/**
 * Structural deep equality for eq/ne. Primitives compare with === (so distinct
 * types are unequal, no coercion); objects/arrays compare by value. Depth-bounded
 * (over-deep operands compare unequal rather than overflowing the stack).
 */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > MAX_CONDITION_DEPTH) return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const ar = a as unknown[], br = b as unknown[];
    if (ar.length !== br.length) return false;
    for (let i = 0; i < ar.length; i++) if (!deepEqual(ar[i], br[i], depth + 1)) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k], depth + 1)) return false;
  }
  return true;
}

/**
 * Resolve a field accessor against the node set.
 *
 * Format: <type>:<id>.<field>[.<subfield>...]
 * Example: prior:e5f6a7b8.val.renewal_outlook
 *
 * Returns undefined if the node or field path doesn't exist.
 */
function resolveField(
  accessor: string,
  nodes: ReadonlyMap<string, CbpNode>
): unknown {
  // Split type:id from the rest
  const dotIdx = accessor.indexOf(".");
  if (dotIdx === -1) {
    throw new ConditionEvalError(
      `Invalid field accessor "${accessor}" — expected format <type>:<id>.<field>`
    );
  }

  const prefix = accessor.slice(0, dotIdx);
  const fieldPath = accessor.slice(dotIdx + 1);

  // prefix is <type>:<id>
  const colonIdx = prefix.indexOf(":");
  if (colonIdx === -1) {
    throw new ConditionEvalError(
      `Invalid field accessor prefix "${prefix}" — expected <type>:<id>`
    );
  }

  const parsedType = prefix.slice(0, colonIdx);
  const nodeId = prefix.slice(colonIdx + 1);

  // Look up the node by id
  const node = nodes.get(nodeId);
  if (!node) {
    return undefined;
  }

  // The accessor's <type>: segment is part of the assertion, not decoration.
  // A node of a different type does not satisfy `state:<id>` vs `prior:<id>`,
  // so a type mismatch is an unresolved field (→ indeterminate/dormant),
  // consistent with fail-closed evaluation.
  if (node.type !== parsedType) {
    return undefined;
  }

  // Walk the field path
  const pathParts = fieldPath.split(".");
  let current: unknown = node;

  for (const part of pathParts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
