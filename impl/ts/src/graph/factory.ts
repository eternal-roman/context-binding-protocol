/**
 * GraphStore factory — selects memory vs filesystem driver.
 *
 * Both REST (createCbpServer) and SDK (CbpClient) construct their store
 * through this factory, so durability (v0.5) applies to both surfaces
 * with a single config switch.
 */

import { GraphStore, type StoreConfig } from "./store.js";
import { PersistentGraphStore } from "./persistence.js";
import type { PersistenceConfig } from "../types/config.js";

export interface CreateGraphStoreOptions {
  /** Invoked when a background persistence flush fails (filesystem driver only). */
  onFlushError?: (err: Error) => void;
}

export function createGraphStore(
  storeConfig: Partial<StoreConfig>,
  persistence?: PersistenceConfig,
  options?: CreateGraphStoreOptions
): GraphStore {
  if (!persistence || persistence.driver === "memory") {
    return new GraphStore(storeConfig);
  }
  if (!persistence.path) {
    throw new Error(
      `createGraphStore: persistence.driver="filesystem" requires persistence.path`
    );
  }
  return new PersistentGraphStore(storeConfig, {
    path: persistence.path,
    onFlushError: options?.onFlushError,
  });
}
