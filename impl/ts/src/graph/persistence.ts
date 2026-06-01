/**
 * Persistent GraphStore — JSON-on-disk durability for v0.5.0.
 *
 * Extends GraphStore with a debounced atomic-snapshot flush. Every
 * mutation (loadNode, insertNode, upsertNode, removeNode, loadEdge,
 * removeEdge, clear) schedules a flush for 1 s after the last mutation.
 * The flush writes canonical JSON to a `.tmp` sibling, then renames
 * atomically onto the target path. Hydration happens synchronously on
 * construction; a missing snapshot is treated as an empty store, a
 * malformed snapshot throws `PersistenceLoadError`.
 *
 * Durability model: debounced snapshot. Worst-case data loss window
 * after a hard crash is `debounceMs` (1 s by default). Invoke `flush()`
 * explicitly or `close()` on shutdown to drain pending writes.
 *
 * @see cbp-architecture.html §IX — Persistence (v0.5)
 */

import { readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { GraphStore, type StoreConfig } from "./store.js";
import { CbpNode } from "../types/node.js";
import { CbpEdge } from "../types/edge.js";
import { canonicalize } from "../wire/canonical.js";

export class PersistenceLoadError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string
  ) {
    super(`Failed to load persistence snapshot from ${path}: ${reason}`);
    this.name = "PersistenceLoadError";
  }
}

export interface PersistentGraphStoreOptions {
  path: string;
  debounceMs?: number;
  /**
   * Invoked when a background (debounced) flush fails. The default handler
   * logs to console.error; callers that need to alert or degrade should
   * supply their own. Explicit `flush()` calls propagate the error directly
   * and do not invoke this callback.
   */
  onFlushError?: (err: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 1000;

function defaultOnFlushError(err: Error): void {
  console.error(
    `PersistentGraphStore: background flush failed: ${err.message}`
  );
}

export class PersistentGraphStore extends GraphStore {
  private readonly snapshotPath: string;
  private readonly debounceMs: number;
  private readonly onFlushError: (err: Error) => void;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightFlush: Promise<void> | null = null;
  private pendingFlush = false;
  private closed = false;

  constructor(
    config: Partial<StoreConfig>,
    options: PersistentGraphStoreOptions
  ) {
    super(config);
    this.snapshotPath = options.path;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onFlushError = options.onFlushError ?? defaultOnFlushError;
    this.hydrate();
  }

  private get tmpPath(): string {
    return `${this.snapshotPath}.tmp`;
  }

  private get bakPath(): string {
    return `${this.snapshotPath}.bak`;
  }

  /**
   * Remove transient files left by a crash mid-write. Best-effort.
   */
  private cleanupTransient(): void {
    for (const p of [this.tmpPath, this.bakPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // best-effort cleanup; ignore
      }
    }
  }

  private hydrate(): void {
    let raw: string;
    try {
      raw = readFileSync(this.snapshotPath, "utf-8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // The destination is missing. A crash during the Windows replace
        // window can leave the previous snapshot as `.bak`. Recover from it
        // rather than silently presenting an empty store (data loss).
        if (existsSync(this.bakPath)) {
          renameSync(this.bakPath, this.snapshotPath);
          raw = readFileSync(this.snapshotPath, "utf-8");
        } else {
          this.cleanupTransient();
          return; // genuinely fresh store
        }
      } else {
        throw new PersistenceLoadError(this.snapshotPath, e.message);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PersistenceLoadError(
        this.snapshotPath,
        `invalid JSON: ${(err as Error).message}`
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new PersistenceLoadError(
        this.snapshotPath,
        "snapshot root is not an object"
      );
    }

    const envelope = parsed as Record<string, unknown>;
    const nodesRaw = envelope.nodes;
    const edgesRaw = envelope.edges;

    if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) {
      throw new PersistenceLoadError(
        this.snapshotPath,
        "snapshot missing nodes or edges arrays"
      );
    }

    for (let i = 0; i < nodesRaw.length; i++) {
      const result = CbpNode.safeParse(nodesRaw[i]);
      if (!result.success) {
        throw new PersistenceLoadError(
          this.snapshotPath,
          `invalid node at index ${i}: ${result.error.message}`
        );
      }
      super.loadNode(result.data);
    }

    for (let i = 0; i < edgesRaw.length; i++) {
      const result = CbpEdge.safeParse(edgesRaw[i]);
      if (!result.success) {
        throw new PersistenceLoadError(
          this.snapshotPath,
          `invalid edge at index ${i}: ${result.error.message}`
        );
      }
      super.loadEdge(result.data);
    }

    // Successful load — drop any transient files a prior crash left behind.
    this.cleanupTransient();
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.performFlush().catch((err) => {
        // Background flush failure: hand off to the configured handler. The
        // next mutation will reschedule; an explicit flush() call surfaces
        // the error directly to its awaiter and bypasses this callback.
        try {
          this.onFlushError(err as Error);
        } catch {
          // The handler itself threw — last-resort log so we don't swallow.
          defaultOnFlushError(err as Error);
        }
      });
    }, this.debounceMs);
  }

  /** Force an immediate flush, awaiting any in-flight flush. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.performFlush();
  }

  private async performFlush(): Promise<void> {
    if (this.inFlightFlush) {
      this.pendingFlush = true;
      await this.inFlightFlush;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        await this.performFlush();
      }
      return;
    }

    this.inFlightFlush = this.doWrite();
    try {
      await this.inFlightFlush;
    } finally {
      this.inFlightFlush = null;
    }

    if (this.pendingFlush) {
      this.pendingFlush = false;
      await this.performFlush();
    }
  }

  private async doWrite(): Promise<void> {
    const snapshot = {
      schema_version: 1,
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
    };
    const body = canonicalize(snapshot);
    const tmpPath = this.tmpPath;
    // Write the full payload to a sibling temp file and fsync it before the
    // rename, so a successful flush() means the bytes are durably on disk
    // (not just buffered) prior to swapping it into place.
    const handle = await fs.open(tmpPath, "w");
    try {
      await handle.writeFile(body, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicRename(tmpPath, this.snapshotPath);
  }

  /** Drain pending flushes and stop scheduling new ones. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.performFlush();
    } else if (this.inFlightFlush) {
      await this.inFlightFlush;
    }
  }

  // --- Mutating method overrides: each schedules a flush. ---

  override loadNode(node: CbpNode): void {
    super.loadNode(node);
    this.scheduleFlush();
  }

  override insertNode(input: Parameters<GraphStore["insertNode"]>[0]): CbpNode {
    const result = super.insertNode(input);
    this.scheduleFlush();
    return result;
  }

  override upsertNode(
    id: string,
    update: Parameters<GraphStore["upsertNode"]>[1],
    expectedV: number
  ): CbpNode {
    const result = super.upsertNode(id, update, expectedV);
    this.scheduleFlush();
    return result;
  }

  override removeNode(id: string): boolean {
    const result = super.removeNode(id);
    if (result) this.scheduleFlush();
    return result;
  }

  override loadEdge(edge: CbpEdge): void {
    super.loadEdge(edge);
    this.scheduleFlush();
  }

  override removeEdge(id: string): boolean {
    const result = super.removeEdge(id);
    if (result) this.scheduleFlush();
    return result;
  }

  override clear(): void {
    super.clear();
    this.scheduleFlush();
  }
}

/**
 * Replace `dest` with `src` as durably as the platform allows.
 *
 * On POSIX, `fs.rename` atomically replaces an existing `dest` in a single
 * syscall — use it directly.
 *
 * On Windows, `fs.rename` throws `EEXIST`/`EPERM` when `dest` exists. The
 * previous fallback removed `dest` first, leaving a window where a crash
 * would lose the snapshot entirely (next hydrate sees ENOENT → empty
 * store). Instead, preserve the old file as `dest.bak` so that at every
 * instant EITHER `dest` OR `dest.bak` exists; hydrate recovers from `.bak`
 * if it finds `dest` missing. The `.bak` is removed only after the new
 * file is safely in place.
 */
async function atomicRename(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const mustFallback =
      process.platform === "win32" && (e.code === "EEXIST" || e.code === "EPERM");
    if (!mustFallback) throw err;
  }

  // Windows replace via backup. dest is known to exist (that's why we're here).
  const bak = `${dest}.bak`;
  await fs.rename(dest, bak); // dest → bak (old preserved; dest now absent)
  try {
    await fs.rename(src, dest); // tmp → dest (new in place)
  } catch (err) {
    // Failed to place the new file — restore the old one so we never end up
    // with neither, then surface the error.
    await fs.rename(bak, dest).catch(() => undefined);
    throw err;
  }
  await fs.unlink(bak).catch(() => undefined); // success — drop the backup
}
