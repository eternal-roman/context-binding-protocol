import { z } from "zod";

/** A structured fact for ingestion. Never type "frame" — anchors are server-managed. */
export const Fact = z.object({
  type: z.enum(["entity", "state", "prior"]),
  val: z.unknown().refine((v) => v !== undefined && v !== null, { message: "val is required" }),
  tags: z.array(z.string()).default([]),
  w: z.number().min(0).max(1).default(0.6),
});
export type Fact = z.infer<typeof Fact>;

export interface ExtractStats { chunks: number; truncated: boolean; facts: number; failedChunks: number }
export interface IngestResult {
  frameId: string;
  ingested: number;
  nodeIds: string[];
  skipped: Array<{ index: number; reason: string }>;
  extract?: ExtractStats;
}
