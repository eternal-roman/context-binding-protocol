import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  PersistentGraphStore,
  PersistenceLoadError,
} from "../../src/graph/persistence.js";
import { canonicalize } from "../../src/wire/canonical.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

const frameNode: CbpNode = {
  id: "f0d2e8a1",
  type: "frame",
  val: { name: "test_frame" },
  w: 1,
  decay: "none",
  ttl: null,
  lineage: null,
  tags: ["domain:testing"],
  v: 1,
  prev: null,
};

const childNode: CbpNode = {
  id: "a7c3f1e2",
  type: "entity",
  val: "Acme Corp",
  w: 0.9,
  decay: "epoch",
  ttl: null,
  lineage: "f0d2e8a1",
  tags: [],
  v: 1,
  prev: null,
};

const sampleEdge: CbpEdge = {
  id: "e1a2b3c4",
  src: "a7c3f1e2",
  tgt: "f0d2e8a1",
  rel: "requires",
  strength: 1,
  conditional: "always",
  w: 1,
  decay: "none",
  ttl: null,
  v: 1,
  prev: null,
};

async function mkTempPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbp-persistence-"));
  return path.join(dir, "snapshot.json");
}

async function rmTempDir(snapshotPath: string): Promise<void> {
  const dir = path.dirname(snapshotPath);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("PersistentGraphStore", () => {
  let snapshotPath: string;

  beforeEach(async () => {
    snapshotPath = await mkTempPath();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rmTempDir(snapshotPath);
  });

  describe("hydration", () => {
    it("starts empty when snapshot file is missing", () => {
      const store = new PersistentGraphStore({}, { path: snapshotPath });
      expect(store.getAllNodes()).toEqual([]);
      expect(store.getAllEdges()).toEqual([]);
    });

    it("hydrates from an existing snapshot file", async () => {
      const snapshot = {
        schema_version: 1,
        nodes: [frameNode, childNode],
        edges: [sampleEdge],
      };
      await fs.writeFile(snapshotPath, canonicalize(snapshot), "utf-8");

      const store = new PersistentGraphStore({}, { path: snapshotPath });
      expect(store.getNode("f0d2e8a1")).toEqual(frameNode);
      expect(store.getNode("a7c3f1e2")).toEqual(childNode);
      expect(store.getEdge("e1a2b3c4")).toEqual(sampleEdge);
    });

    it("throws PersistenceLoadError on malformed JSON", async () => {
      await fs.writeFile(snapshotPath, "{not valid json", "utf-8");
      expect(
        () => new PersistentGraphStore({}, { path: snapshotPath })
      ).toThrow(PersistenceLoadError);
    });

    it("throws PersistenceLoadError on missing arrays", async () => {
      await fs.writeFile(
        snapshotPath,
        JSON.stringify({ schema_version: 1 }),
        "utf-8"
      );
      expect(
        () => new PersistentGraphStore({}, { path: snapshotPath })
      ).toThrow(PersistenceLoadError);
    });

    it("throws PersistenceLoadError on schema violation", async () => {
      const bogus = {
        schema_version: 1,
        nodes: [{ id: "bad", type: "not-a-type" }],
        edges: [],
      };
      await fs.writeFile(snapshotPath, JSON.stringify(bogus), "utf-8");
      expect(
        () => new PersistentGraphStore({}, { path: snapshotPath })
      ).toThrow(PersistenceLoadError);
    });
  });

  describe("debounce", () => {
    it("defers flush until debounceMs after the last mutation", async () => {
      const debounceMs = 150;
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs }
      );

      store.loadNode(frameNode);
      await new Promise((r) => setTimeout(r, debounceMs / 2));
      store.loadNode(childNode);
      await new Promise((r) => setTimeout(r, debounceMs / 2));

      // ~debounceMs total elapsed, but only ~debounceMs/2 since last mutation.
      await expect(fs.access(snapshotPath)).rejects.toThrow();

      await new Promise((r) => setTimeout(r, debounceMs + 50));

      const body = await fs.readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(body) as { nodes: CbpNode[] };
      expect(parsed.nodes.map((n) => n.id).sort()).toEqual([
        "a7c3f1e2",
        "f0d2e8a1",
      ]);

      await store.close();
    });

    it("coalesces repeated mutations into a single write", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 50 }
      );
      for (let i = 0; i < 10; i++) {
        store.loadNode({ ...childNode, id: `a000000${i}`, val: i });
      }
      await store.flush();

      const body = await fs.readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(body) as { nodes: CbpNode[] };
      expect(parsed.nodes).toHaveLength(10);

      await store.close();
    });
  });

  describe("atomic write", () => {
    it("round-trips canonical nodes/edges through flush + rehydrate", async () => {
      const store1 = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store1.loadNode(frameNode);
      store1.loadNode(childNode);
      store1.loadEdge(sampleEdge);
      await store1.flush();
      await store1.close();

      const store2 = new PersistentGraphStore({}, { path: snapshotPath });
      expect(store2.getNode("f0d2e8a1")).toEqual(frameNode);
      expect(store2.getNode("a7c3f1e2")).toEqual(childNode);
      expect(store2.getEdge("e1a2b3c4")).toEqual(sampleEdge);
    });

    it("overwrites an existing snapshot on subsequent flushes (Windows rename edge case)", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store.loadNode(frameNode);
      await store.flush();

      store.loadNode(childNode);
      await store.flush();

      const body = await fs.readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(body) as { nodes: CbpNode[] };
      expect(parsed.nodes.map((n) => n.id).sort()).toEqual([
        "a7c3f1e2",
        "f0d2e8a1",
      ]);

      await store.close();
    });

    it("does not leave a .tmp file after a successful flush", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store.loadNode(frameNode);
      await store.flush();
      await expect(fs.access(`${snapshotPath}.tmp`)).rejects.toThrow();
      await store.close();
    });
  });

  describe("shutdown", () => {
    it("close() drains pending debounced writes", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10_000 }
      );
      store.loadNode(frameNode);
      // Debounce is 10 s; close() must not wait for the timer.
      await store.close();

      const body = await fs.readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(body) as { nodes: CbpNode[] };
      expect(parsed.nodes).toHaveLength(1);
    });

    it("close() is idempotent", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store.loadNode(frameNode);
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    });

    it("mutations after close() do not schedule further writes", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store.loadNode(frameNode);
      await store.close();
      const statBefore = await fs.stat(snapshotPath);

      store.loadNode(childNode);
      // Wait long enough that a scheduled flush would fire if close() didn't
      // disarm it.
      await new Promise((r) => setTimeout(r, 80));
      const statAfter = await fs.stat(snapshotPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });
  });

  describe("onFlushError callback", () => {
    it("invokes the callback when a background flush fails", async () => {
      const badPath = path.join(snapshotPath, "nonexistent-dir", "snapshot.json");
      const errors: Error[] = [];
      const store = new PersistentGraphStore(
        {},
        {
          path: badPath,
          debounceMs: 20,
          onFlushError: (err: Error): void => {
            errors.push(err);
          },
        }
      );
      store.loadNode(frameNode);
      // Wait past debounce + write attempt.
      await new Promise((r) => setTimeout(r, 150));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toBeInstanceOf(Error);
      // Prevent further scheduling that would log after the test.
      // Close swallows any in-flight promise.
      try {
        await store.close();
      } catch {
        /* expected — close triggers another failing flush */
      }
    });

    it("explicit flush() propagates errors directly, bypassing the callback", async () => {
      const badPath = path.join(snapshotPath, "nonexistent-dir", "snapshot.json");
      const errors: Error[] = [];
      const store = new PersistentGraphStore(
        {},
        {
          path: badPath,
          debounceMs: 60_000,
          onFlushError: (err: Error): void => {
            errors.push(err);
          },
        }
      );
      store.loadNode(frameNode);
      await expect(store.flush()).rejects.toThrow();
      expect(errors).toHaveLength(0);
    });
  });

  describe("mutation during in-flight flush", () => {
    it("captures late mutations in a follow-up flush", async () => {
      const store = new PersistentGraphStore(
        {},
        { path: snapshotPath, debounceMs: 10 }
      );
      store.loadNode(frameNode);
      const firstFlush = store.flush();
      // Mutate while the first flush is running.
      store.loadNode(childNode);
      await firstFlush;
      // The mutation that landed during the in-flight flush is now in a
      // newly armed debounced timer. Force it.
      await store.flush();

      const body = await fs.readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(body) as { nodes: CbpNode[] };
      expect(parsed.nodes.map((n) => n.id).sort()).toEqual([
        "a7c3f1e2",
        "f0d2e8a1",
      ]);

      await store.close();
    });
  });
});
