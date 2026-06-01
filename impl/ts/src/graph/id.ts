/**
 * BLAKE3-based node id derivation (G1).
 *
 * Hashes the canonical JSON of the node's content fields
 * (type, val, lineage, tags) to produce a deterministic identifier.
 * The display id is the first 8 hex characters of the hash, extended
 * on collision.
 *
 * @see spec/schemas/node.schema.json — "id" field definition
 * @see cbp-architecture.html Section II — Node Schema (identity derivation)
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalize } from "../wire/canonical.js";
import type { CbpNode } from "../types/node.js";
import { CONTENT_FIELDS } from "../types/node.js";

const DEFAULT_DISPLAY_LENGTH = 8;

/**
 * Compute the full 32-byte BLAKE3 hash of a node's content fields.
 * Returns the hex string (64 characters).
 */
export function computeFullHash(node: Pick<CbpNode, "type" | "val" | "lineage" | "tags">): string {
  const content: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) {
    content[field] = node[field];
  }
  const canonical = canonicalize(content);
  const hash = blake3(new TextEncoder().encode(canonical));
  return bytesToHex(hash);
}

/**
 * Derive the display id for a node.
 *
 * @param node - The node whose content fields are hashed.
 * @param displayLength - Number of hex characters to show (default 8).
 *   Extended on collision up to 64 (the full hash).
 * @returns The truncated hex id.
 */
export function deriveId(
  node: Pick<CbpNode, "type" | "val" | "lineage" | "tags">,
  displayLength: number = DEFAULT_DISPLAY_LENGTH
): string {
  const fullHash = computeFullHash(node);
  return fullHash.slice(0, displayLength);
}

/**
 * Find the shortest non-colliding display id for a node given a set
 * of existing ids. Starts at 8 chars and extends one char at a time.
 */
export function deriveUniqueId(
  node: Pick<CbpNode, "type" | "val" | "lineage" | "tags">,
  existingIds: ReadonlySet<string>
): string {
  const fullHash = computeFullHash(node);

  for (let len = DEFAULT_DISPLAY_LENGTH; len <= 64; len++) {
    const candidate = fullHash.slice(0, len);
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  // Full 64-char hash collision — astronomically unlikely but handled.
  throw new Error(
    `BLAKE3 full-hash collision detected for content: ${canonicalize({
      type: node.type,
      val: node.val,
      lineage: node.lineage,
      tags: node.tags,
    })}`
  );
}
