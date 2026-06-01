import { describe, it, expect } from "vitest";
import { slugify, HeuristicEntityTagger } from "../../src/ingest/entity-tagger.js";

describe("slugify — possessive normalization", () => {
  it("drops a possessive 's so the query slug matches the indexed entity slug", () => {
    expect(slugify("Alice Chen's")).toBe("alice-chen");
    expect(slugify("Nimbus Robotics's")).toBe("nimbus-robotics");
  });
  it("leaves non-possessive trailing s untouched", () => {
    expect(slugify("Robotics")).toBe("robotics");
    expect(slugify("Athens")).toBe("athens");
  });
  it("keeps prior behavior for clean multi-word names", () => {
    expect(slugify("Nimbus Robotics")).toBe("nimbus-robotics");
  });
  it("tagger extracts a possessive entity to the same slug as the plain name", () => {
    const t = new HeuristicEntityTagger();
    expect(t.tag("In which region is Alice Chen's company located?")).toEqual(["alice-chen"]);
  });
});
