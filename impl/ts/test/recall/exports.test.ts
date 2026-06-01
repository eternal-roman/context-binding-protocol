import { describe, it, expect } from "vitest";
import * as cbp from "../../src/index.js";

describe("public exports (closes the 'memory never exported' finding)", () => {
  it("exports the memory substrate and the recall seam from the package root", () => {
    expect(typeof cbp.HashingEmbedder).toBe("function");      // ./memory
    expect(typeof cbp.InMemoryMemoryStore).toBe("function");  // ./memory
    expect(typeof cbp.assembleContext).toBe("function");      // ./recall
    expect(typeof cbp.RecallPipeline).toBe("function");       // ./recall
    expect(typeof cbp.EchoLlmClient).toBe("function");        // ./recall
  });
});
