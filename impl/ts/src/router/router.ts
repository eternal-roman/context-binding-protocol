/**
 * Frame Router — tier negotiation and conversation state tracking.
 *
 * Tracks which tier was last delivered for each frame in each
 * conversation. Implements the tier:auto decision logic:
 * - First encounter with a frame → Full
 * - Subsequent turns → Condensed (if delta ratio warrants it)
 * - After signal_min_turns of Full → Signal eligible
 *
 * @see cbp-architecture.html Section IV — Tier Negotiation Flow
 * @see spec/schemas/config.schema.json — compression settings
 */

import type { Tier, FullPayload, SerializedPayload } from "../serializer/serializer.js";
import type { ResolvedFrame } from "../resolver/resolver.js";
import { serializeFrame } from "../serializer/serializer.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";

export interface ConversationState {
  /** Last Full payload delivered for this frame in this conversation. */
  lastFull: FullPayload | null;
  /** Number of turns since the last Full was delivered. */
  turnsSinceFull: number;
  /** Frame version at last delivery. */
  lastDeliveredVersion: number;
}

export interface RouterConfig {
  /** Min delta ratio to trigger condensed instead of re-sending full. */
  condensedThreshold: number;
  /** Turns that must have received Full before Signal is permitted. */
  signalMinTurns: number;
  /**
   * Max number of distinct conversations to retain state for. The
   * conversation id is client-supplied (X-CBP-Conversation), so without a
   * cap a client cycling unique ids would grow memory without bound (each
   * entry retains a full payload). When the cap is exceeded the
   * least-recently-used conversation is evicted.
   */
  maxConversations: number;
}

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  condensedThreshold: 0.3,
  signalMinTurns: 3,
  maxConversations: 10_000,
};

/**
 * Router's rationale for the tier it negotiated. Surfaces via the
 * `X-CBP-Tier-Reason` response header on GET /v1/frame/:id so clients
 * can observe the decision without reading router state.
 */
export type TierReason =
  | "client_requested"
  | "first_turn"
  | "signal_threshold_met"
  | "condensed_default";

export class FrameRouter {
  private readonly conversations = new Map<string, Map<string, ConversationState>>();
  private readonly config: RouterConfig;

  constructor(config: Partial<RouterConfig> = {}) {
    // Nullish-coalesce per field so an explicit `undefined` (e.g. a
    // ServerConfig literal that omits max_conversations and bypasses
    // ServerConfig.parse) falls back to the default rather than disabling
    // the bound.
    this.config = {
      condensedThreshold:
        config.condensedThreshold ?? DEFAULT_ROUTER_CONFIG.condensedThreshold,
      signalMinTurns:
        config.signalMinTurns ?? DEFAULT_ROUTER_CONFIG.signalMinTurns,
      // Clamp to >= 1: an explicit 0 (via a direct constructor call that
      // bypasses ServerConfig.parse) would make the eviction loop never evict,
      // letting conversation state grow unbounded.
      maxConversations: Math.max(
        1,
        config.maxConversations ?? DEFAULT_ROUTER_CONFIG.maxConversations
      ),
    };
  }

  /**
   * Resolve the effective tier for a request.
   *
   * @param conversationId - Unique identifier for the conversation.
   * @param frameId - The frame being requested.
   * @param requestedTier - Client's tier preference ("auto" or specific).
   * @returns The tier that should actually be used.
   */
  negotiateTier(
    conversationId: string,
    frameId: string,
    requestedTier: "full" | "condensed" | "signal" | "auto"
  ): Tier {
    return this.negotiateTierWithReason(conversationId, frameId, requestedTier).tier;
  }

  /**
   * Same as `negotiateTier` but also returns the router's rationale,
   * suitable for surfacing to clients via a response header.
   */
  negotiateTierWithReason(
    conversationId: string,
    frameId: string,
    requestedTier: "full" | "condensed" | "signal" | "auto"
  ): { tier: Tier; reason: TierReason } {
    if (requestedTier !== "auto") {
      return { tier: requestedTier, reason: "client_requested" };
    }

    const state = this.getState(conversationId, frameId);

    if (!state.lastFull) return { tier: "full", reason: "first_turn" };
    if (state.turnsSinceFull >= this.config.signalMinTurns) {
      return { tier: "signal", reason: "signal_threshold_met" };
    }
    return { tier: "condensed", reason: "condensed_default" };
  }

  /**
   * Deliver a frame: negotiate tier, serialize, update conversation state.
   *
   * This is the main entry point for the REST and WebSocket surfaces.
   */
  deliver(
    conversationId: string,
    resolved: ResolvedFrame,
    frameVersion: number,
    requestedTier: "full" | "condensed" | "signal" | "auto",
    tokenizer?: Tokenizer
  ): {
    payload: SerializedPayload;
    wire: string;
    tokens: number;
    actualTier: Tier;
    reason: TierReason;
  } {
    const { tier, reason } = this.negotiateTierWithReason(
      conversationId,
      resolved.frame.id,
      requestedTier
    );
    const state = this.getState(conversationId, resolved.frame.id);

    const result = serializeFrame(resolved, frameVersion, {
      tier,
      tokenizer,
      previousFull: state.lastFull ?? undefined,
    });

    // Update conversation state
    if (result.actualTier === "full") {
      state.lastFull = result.payload as FullPayload;
      state.turnsSinceFull = 0;
    } else {
      state.turnsSinceFull++;
    }
    state.lastDeliveredVersion = frameVersion;

    return { ...result, reason };
  }

  /**
   * Get the conversation state for a frame.
   * Creates a new state if none exists.
   *
   * The outer `conversations` map is an LRU bounded by
   * `config.maxConversations`: touching an existing conversation moves it
   * to the most-recently-used position, and inserting a new one past the
   * cap evicts the least-recently-used. A JS `Map` preserves insertion
   * order, so the first key is always the LRU.
   */
  getState(conversationId: string, frameId: string): ConversationState {
    let convMap = this.conversations.get(conversationId);
    if (convMap) {
      // Touch: re-insert to mark as most-recently-used.
      this.conversations.delete(conversationId);
      this.conversations.set(conversationId, convMap);
    } else {
      // Evict the LRU (oldest insertion) until there is room for the new one.
      while (this.conversations.size >= this.config.maxConversations) {
        const oldest = this.conversations.keys().next().value;
        if (oldest === undefined) break;
        this.conversations.delete(oldest);
      }
      convMap = new Map();
      this.conversations.set(conversationId, convMap);
    }

    let state = convMap.get(frameId);
    if (!state) {
      state = { lastFull: null, turnsSinceFull: 0, lastDeliveredVersion: 0 };
      convMap.set(frameId, state);
    }

    return state;
  }

  /** Number of distinct conversations currently retained. */
  get conversationCount(): number {
    return this.conversations.size;
  }

  /** Whether state is retained for a conversation (without creating it). */
  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  /** Clear all conversation state. */
  clearAll(): void {
    this.conversations.clear();
  }

  /** Clear state for a specific conversation. */
  clearConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
  }
}
