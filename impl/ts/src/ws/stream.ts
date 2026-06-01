/**
 * WebSocket streaming — push Condensed/Signal deltas as state changes.
 *
 * Mode 3 from cbp-architecture.html §VI: "WebSocket connection pushes
 * Condensed or Signal tier updates as the underlying data changes."
 *
 * Clients connect to ws://<host>/v1/stream/<frame_id> and receive
 * serialized payloads whenever the frame's nodes or edges change.
 *
 * @see cbp-architecture.html Section VI — Mode 3: Streaming Delta
 */

import type { ResolvedFrame } from "../resolver/resolver.js";
import type { FrameRouter, TierReason } from "../router/router.js";
import type { Tier, SerializedPayload } from "../serializer/serializer.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";

export interface StreamSubscription {
  conversationId: string;
  frameId: string;
  preferredTier: Tier | "auto";
  send(data: string): void;
  close(): void;
}

export interface StreamResult {
  payload: SerializedPayload;
  wire: string;
  tokens: number;
  actualTier: Tier;
  reason: TierReason;
}

/**
 * Lightweight mutation event pushed to WebSocket subscribers (v0.7).
 * Deliberately minimal — the subscriber decides whether to re-read the
 * frame via `GET /v1/frame/:id/export` in response. Keeps the hot path
 * free of full-serialization work on every mutation.
 */
export type MutationEvent =
  | { event: "node_upserted"; frame_id: string; node_id: string; v: number }
  | { event: "node_removed"; frame_id: string; node_id: string }
  | { event: "edge_upserted"; frame_id: string; edge_id: string; v: number }
  | { event: "edge_removed"; frame_id: string; edge_id: string }
  | { event: "import_committed"; frame_id: string; nodes: number; edges: number };

/**
 * WebSocket stream manager.
 *
 * Maintains active subscriptions and pushes deltas when notified
 * of frame changes.
 */
export class StreamManager {
  private readonly subscriptions = new Map<string, Set<StreamSubscription>>();

  /**
   * Add a subscription for a frame.
   * @returns Unsubscribe function.
   */
  subscribe(sub: StreamSubscription): () => void {
    const key = sub.frameId;
    let subs = this.subscriptions.get(key);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(key, subs);
    }
    subs.add(sub);

    return (): void => {
      subs?.delete(sub);
      if (subs?.size === 0) {
        this.subscriptions.delete(key);
      }
    };
  }

  /**
   * Notify all subscribers of a frame change.
   * Delivers the resolved frame through the router for tier negotiation.
   */
  notify(
    frameId: string,
    resolved: ResolvedFrame,
    frameVersion: number,
    router: FrameRouter,
    tokenizer?: Tokenizer
  ): StreamResult[] {
    const subs = this.subscriptions.get(frameId);
    if (!subs || subs.size === 0) return [];

    const results: StreamResult[] = [];

    for (const sub of subs) {
      const result = router.deliver(
        sub.conversationId,
        resolved,
        frameVersion,
        sub.preferredTier === "auto" ? "auto" : sub.preferredTier,
        tokenizer
      );

      sub.send(result.wire);
      results.push(result);
    }

    return results;
  }

  /**
   * Push a lightweight mutation event to every subscriber of a frame
   * (v0.7). Unlike `notify`, this does not run the serializer or the
   * router — it broadcasts a small JSON envelope so subscribers learn
   * that state has changed and can decide whether to re-read.
   */
  notifyEvent(event: MutationEvent): number {
    const subs = this.subscriptions.get(event.frame_id);
    if (!subs || subs.size === 0) return 0;
    const wire = JSON.stringify(event);
    let delivered = 0;
    for (const sub of subs) {
      sub.send(wire);
      delivered++;
    }
    return delivered;
  }

  /** Get the number of active subscriptions for a frame. */
  subscriberCount(frameId: string): number {
    return this.subscriptions.get(frameId)?.size ?? 0;
  }

  /** Close all subscriptions for a frame. */
  closeAll(frameId: string): void {
    const subs = this.subscriptions.get(frameId);
    if (subs) {
      for (const sub of subs) {
        sub.close();
      }
      this.subscriptions.delete(frameId);
    }
  }

  /** Close all subscriptions across all frames. */
  shutdown(): void {
    for (const [frameId] of this.subscriptions) {
      this.closeAll(frameId);
    }
  }
}
