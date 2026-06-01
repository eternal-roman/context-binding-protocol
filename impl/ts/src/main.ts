/**
 * Runnable CBP REST server entry point.
 *
 * Starts an in-memory server with one demo frame and a single bearer token, so
 * `pnpm start` yields a working API immediately. Configure via environment:
 *   PORT       (default 3000)
 *   HOST       (default 127.0.0.1)
 *   CBP_TOKEN  (default "dev-token" — set this for any real use)
 *
 * @see cbp-architecture.html Section IX — Interface Contract
 */
import { createCbpServer } from "./rest/server.js";
import { ServerConfig } from "./types/config.js";
import { FrameConfig } from "./types/frame.js";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const TOKEN = process.env["CBP_TOKEN"] ?? "dev-token";

async function main(): Promise<void> {
  const serverConfig = ServerConfig.parse({});
  const demoFrame = FrameConfig.parse({
    id: "demo",
    root_weight: 1,
    root_decay: "none",
    max_token_budget: 2000,
    inheritance_mode: "prototypal",
  });

  const server = createCbpServer({
    port: PORT,
    host: HOST,
    serverConfig,
    tokens: new Map([[TOKEN, "default"]]),
    frames: new Map([[demoFrame.id, demoFrame]]),
  });

  const address = await server.start();
  if (!process.env["CBP_TOKEN"]) {
    server.app.log.warn('CBP_TOKEN not set — using insecure default "dev-token". Set CBP_TOKEN before any real use.');
  }
  server.app.log.info(`CBP server listening at ${address} — frame "demo" available; all /v1 routes require the bearer token.`);

  const shutdown = (): void => {
    void server.stop().then((): never => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown): void => {
  console.error("[cbp] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
