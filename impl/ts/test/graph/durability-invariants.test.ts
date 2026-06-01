/**
 * Persistence durability invariants (root cause G — data loss).
 *
 * The Windows snapshot-replace path must never leave a window in which the
 * only copy of the data can vanish. A crash mid-replace must NOT surface as
 * a silently-empty store on the next startup; it must recover from the
 * preserved backup. Leftover transient files are cleaned up.
 *
 * @see cbp-architecture.html §IX (persistence)
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PersistentGraphStore } from "../../src/graph/persistence.js";
import type { CbpNode } from "../../src/types/node.js";

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

const dirs: string[] = [];

async function mkTempPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbp-durability-"));
  dirs.push(dir);
  return path.join(dir, "snapshot.json");
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("persistence durability", () => {
  it("recovers from a .bak left by an interrupted replace (no silent empty store)", async () => {
    const p = await mkTempPath();
    const store = new PersistentGraphStore({}, { path: p });
    store.loadNode(frameNode);
    await store.flush();
    await store.close();

    // Simulate a crash during the Windows replace window: the live snapshot
    // has been moved aside to .bak and the destination does not yet exist.
    await fs.rename(p, `${p}.bak`);
    await expect(fs.access(p)).rejects.toBeTruthy(); // dest is gone

    const recovered = new PersistentGraphStore({}, { path: p });
    expect(recovered.getNode("f0d2e8a1")).toBeDefined(); // not an empty store
    await recovered.close();
  });

  it("removes a leftover .tmp after a successful load", async () => {
    const p = await mkTempPath();
    const store = new PersistentGraphStore({}, { path: p });
    store.loadNode(frameNode);
    await store.flush();
    await store.close();

    await fs.writeFile(`${p}.tmp`, "partial-garbage", "utf-8"); // stray from a crash

    const reopened = new PersistentGraphStore({}, { path: p });
    await reopened.close();

    await expect(fs.access(`${p}.tmp`)).rejects.toBeTruthy(); // cleaned up
  });
});
