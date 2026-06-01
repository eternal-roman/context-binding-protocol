/**
 * Entity → facts OVERLAY index. Maps a canonical entity slug to the node ids of
 * facts mentioning it. Held OUTSIDE the node content hash: entity membership must
 * NOT enter a node's `tags`, which are BLAKE3-hashed into its id (CONTENT_FIELDS),
 * so writing entity tags into `tags` would fork node identity and break content
 * dedup. The sole reachability substrate for graph traversal — see proposal
 * 0004-B §5A/§5B.
 */
export class EntityIndex {
  private readonly bySlug = new Map<string, Set<string>>();
  private readonly byNode = new Map<string, Set<string>>();

  /** Idempotent: record that `nodeId` mentions each slug. Re-adding is a no-op. */
  add(nodeId: string, slugs: readonly string[]): void {
    for (const slug of slugs) {
      let s = this.bySlug.get(slug);
      if (!s) { s = new Set<string>(); this.bySlug.set(slug, s); }
      s.add(nodeId);
      let n = this.byNode.get(nodeId);
      if (!n) { n = new Set<string>(); this.byNode.set(nodeId, n); }
      n.add(slug);
    }
  }

  /** Node ids of facts mentioning `slug` (insertion-stable order); [] if none. */
  lookup(slug: string): string[] {
    const s = this.bySlug.get(slug);
    return s ? [...s] : [];
  }

  /** Slugs recorded for `nodeId`; [] if none. */
  slugsOf(nodeId: string): string[] {
    const n = this.byNode.get(nodeId);
    return n ? [...n] : [];
  }

  /** Count of distinct slugs indexed. */
  get slugCount(): number { return this.bySlug.size; }
}
