/**
 * CBQ (CBP Query) parser — reference implementation of spec/cbq.ebnf.
 *
 * Parses comma-separated predicate strings into a structured AST.
 * Predicates are combined with logical AND per the grammar.
 *
 * @see spec/cbq.ebnf
 * @see cbp-architecture.html Section IX
 */

import { NodeType } from "../types/node.js";

export type CbqPredicate =
  | WeightPredicate
  | TagPredicate
  | TypePredicate
  | RootPredicate
  | DepthPredicate
  | EdgesPredicate
  | IdPredicate;

export interface WeightPredicate {
  kind: "weight";
  op: ">" | ">=" | "<" | "<=" | "=" | "!=";
  value: number;
}

export interface TagPredicate {
  kind: "tag";
  tag: string;
}

export interface TypePredicate {
  kind: "type";
  // Mirror the canonical NodeType enum so the parser can never drift out of
  // sync with the data model (the removed `relation` type is what caused
  // `type:relation` to parse yet match nothing).
  nodeType: NodeType;
}

export interface RootPredicate {
  kind: "root";
  nodeId: string;
}

export interface DepthPredicate {
  kind: "depth";
  value: number;
}

export interface EdgesPredicate {
  kind: "edges";
  filter: "active" | "all" | "dormant";
}

export interface IdPredicate {
  kind: "id";
  nodeId: string;
}

export interface CbqQuery {
  predicates: CbqPredicate[];
}

export class CbqParseError extends Error {
  constructor(
    message: string,
    public readonly input: string,
    public readonly position: number
  ) {
    super(`CBQ parse error at position ${position}: ${message} (input: "${input}")`);
    this.name = "CbqParseError";
  }
}

const NODE_TYPES = new Set<string>(NodeType.options);
const EDGE_FILTERS = new Set(["active", "all", "dormant"]);
const COMPARISON_OPS = [">=", "<=", "!=", ">", "<", "="] as const;

/**
 * Parse a CBQ query string into a structured query.
 *
 * @param input - The CBQ query string (e.g., "w>0.5,tag:regime,edges:active")
 * @returns Parsed query with an array of predicates (AND-combined)
 * @throws CbqParseError on invalid syntax
 */
export function parseCbq(input: string): CbqQuery {
  if (input.trim() === "") {
    return { predicates: [] };
  }

  const parts = input.split(",");
  const predicates: CbqPredicate[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    predicates.push(parsePredicate(trimmed, input));
  }

  return { predicates };
}

function parsePredicate(token: string, fullInput: string): CbqPredicate {
  // Weight predicate: w<op><number>
  if (token.startsWith("w") && token.length > 1 && !token.startsWith("w:")) {
    return parseWeightPredicate(token, fullInput);
  }

  // Colon-based predicates
  const colonIdx = token.indexOf(":");
  if (colonIdx === -1) {
    throw new CbqParseError(
      `Unrecognized predicate: "${token}"`,
      fullInput,
      fullInput.indexOf(token)
    );
  }

  const prefix = token.slice(0, colonIdx);
  const value = token.slice(colonIdx + 1);

  switch (prefix) {
    case "tag":
      return parseTagPredicate(value, fullInput);
    case "type":
      return parseTypePredicate(value, fullInput);
    case "root":
      return parseRootPredicate(value, fullInput);
    case "depth":
      return parseDepthPredicate(value, fullInput);
    case "edges":
      return parseEdgesPredicate(value, fullInput);
    case "id":
      return parseIdPredicate(value, fullInput);
    default:
      throw new CbqParseError(
        `Unknown predicate prefix: "${prefix}"`,
        fullInput,
        fullInput.indexOf(token)
      );
  }
}

function parseWeightPredicate(
  token: string,
  fullInput: string
): WeightPredicate {
  // token starts with "w", rest is <op><number>
  const rest = token.slice(1);

  for (const op of COMPARISON_OPS) {
    if (rest.startsWith(op)) {
      const numStr = rest.slice(op.length);
      const value = Number(numStr);
      if (isNaN(value)) {
        throw new CbqParseError(
          `Invalid number in weight predicate: "${numStr}"`,
          fullInput,
          fullInput.indexOf(token)
        );
      }
      return { kind: "weight", op, value };
    }
  }

  throw new CbqParseError(
    `Invalid operator in weight predicate: "${rest}"`,
    fullInput,
    fullInput.indexOf(token)
  );
}

function parseTagPredicate(value: string, fullInput: string): TagPredicate {
  if (value === "") {
    throw new CbqParseError(
      "Empty tag value",
      fullInput,
      fullInput.indexOf("tag:")
    );
  }
  return { kind: "tag", tag: value };
}

function parseTypePredicate(value: string, fullInput: string): TypePredicate {
  if (!NODE_TYPES.has(value)) {
    throw new CbqParseError(
      `Invalid node type: "${value}". Must be one of: ${[...NODE_TYPES].join(", ")}`,
      fullInput,
      fullInput.indexOf("type:")
    );
  }
  return {
    kind: "type",
    nodeType: value as TypePredicate["nodeType"],
  };
}

function parseRootPredicate(value: string, fullInput: string): RootPredicate {
  if (value === "") {
    throw new CbqParseError(
      "Empty root node id",
      fullInput,
      fullInput.indexOf("root:")
    );
  }
  return { kind: "root", nodeId: value };
}

function parseDepthPredicate(value: string, fullInput: string): DepthPredicate {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new CbqParseError(
      `Invalid depth value: "${value}". Must be a non-negative integer.`,
      fullInput,
      fullInput.indexOf("depth:")
    );
  }
  return { kind: "depth", value: num };
}

function parseEdgesPredicate(
  value: string,
  fullInput: string
): EdgesPredicate {
  if (!EDGE_FILTERS.has(value)) {
    throw new CbqParseError(
      `Invalid edges filter: "${value}". Must be one of: ${[...EDGE_FILTERS].join(", ")}`,
      fullInput,
      fullInput.indexOf("edges:")
    );
  }
  return { kind: "edges", filter: value as EdgesPredicate["filter"] };
}

function parseIdPredicate(value: string, fullInput: string): IdPredicate {
  if (value === "") {
    throw new CbqParseError(
      "Empty id value",
      fullInput,
      fullInput.indexOf("id:")
    );
  }
  return { kind: "id", nodeId: value };
}
