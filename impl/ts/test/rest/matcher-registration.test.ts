/**
 * The REST server is batteries-included for the `matches` operator.
 *
 * `re2` is an opt-in engine for the core primitives (see resolver/safe-match.ts),
 * but the REST server is the full app tier: `createCbpServer` registers the
 * reference RE2 engine on construction, so a frame with a `matches`-conditioned
 * edge resolves over HTTP without the integrator separately wiring an engine.
 *
 * This isolates the server's registration responsibility from the global test
 * setup (test/setup.ts also registers re2): it CLEARS the matcher first, then
 * asserts that constructing a server re-registers it. Before Phase 1 wired the
 * registration into createCbpServer, this test fails — that is its RED state.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createCbpServer } from "../../src/rest/server.js";
import { ServerConfig } from "../../src/types/config.js";
import {
  getMatcher,
  registerMatcher,
  clearMatcher,
  type Matcher,
} from "../../src/resolver/safe-match.js";

describe("createCbpServer registers the matches engine (self-contained server)", () => {
  let saved: Matcher | null = null;
  afterEach(() => {
    clearMatcher();
    if (saved) registerMatcher(saved);
  });

  it("registers the re2 matcher on construction, even if none was registered", async () => {
    saved = getMatcher();
    clearMatcher();
    expect(getMatcher()).toBeNull();

    const server = createCbpServer({
      port: 0,
      host: "127.0.0.1",
      serverConfig: ServerConfig.parse({}),
      tokens: new Map([["dev-token", "default"]]),
      frames: new Map(),
    });

    try {
      expect(getMatcher()?.name).toBe("re2");
    } finally {
      await server.app.close();
    }
  });
});
