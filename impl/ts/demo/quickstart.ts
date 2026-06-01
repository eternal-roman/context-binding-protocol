/**
 * CBP quickstart — dependency-free, no API key, fully in-process.
 *
 * Stores structured facts in a frame, then recalls them by query and assembles
 * the top matches into a token budget. Runs anywhere: no model download, no
 * network.
 *
 *   pnpm demo
 *
 * NOTE ON RECALL QUALITY: the default embedder (HashingEmbedder) is a
 * dependency-free, bag-of-words *lexical* matcher — it ranks by shared words,
 * not meaning. It is fine for demos and lexical lookup. For semantic recall
 * (matching paraphrases), implement the small `Embedder` interface
 * (src/memory/embedder.ts) with a real embedding model and pass it in.
 */
import { CbpClient } from "../src/sdk/client.js";
import { FrameConfig } from "../src/types/frame.js";

async function main(): Promise<void> {
  const frameConfig = FrameConfig.parse({
    id: "onboarding",
    root_weight: 1,
    root_decay: "none",
    max_token_budget: 2000,
    inheritance_mode: "prototypal",
  });
  const client = new CbpClient({ frameConfig, writeAccess: true });

  const result = await client.ingest([
    { type: "entity", val: "Priya Nair is the on-call lead for deployment and outage incidents.", w: 0.9, tags: [] },
    { type: "state", val: "Postgres database backups run nightly and are retained for thirty days.", w: 0.8, tags: [] },
    { type: "prior", val: "Production deployment is frozen on Fridays by a hard freeze policy.", w: 0.8, tags: [] },
    { type: "state", val: "Staging credentials rotate every ninety days in the Vault secret store.", w: 0.7, tags: [] },
    { type: "prior", val: "The legacy billing service is deprecated and accepts no new integrations.", w: 0.6, tags: [] },
  ]);
  console.log(`\n  Stored ${result.ingested} facts in frame "${frameConfig.id}" (HashingEmbedder, in-memory).\n`);

  // Queries share content words with their target fact (lexical recall).
  const questions = [
    "Who is the on-call lead for a deployment outage?",
    "How long are Postgres database backups retained?",
    "Is production deployment frozen on Fridays?",
  ];
  for (const q of questions) {
    const ctx = await client.recall(q, { k: 3 });
    console.log(`  Q: ${q}`);
    ctx.entries.forEach((e, i) => {
      console.log(`     ${i === 0 ? "→" : " "} [${e.score.toFixed(3)}] ${e.text}`);
    });
    console.log(`     (assembled ${ctx.entries.length} of ${ctx.entries.length + ctx.dropped.length} matches into ${ctx.tokensUsed}/${frameConfig.max_token_budget} tokens)\n`);
  }
}

main().catch((err: unknown): void => {
  console.error("[quickstart] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
