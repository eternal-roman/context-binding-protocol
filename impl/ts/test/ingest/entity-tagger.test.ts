import { describe, it, expect } from "vitest";
import { slugify, HeuristicEntityTagger } from "../../src/ingest/entity-tagger.js";

describe("slugify", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(slugify("Nimbus Robotics")).toBe("nimbus-robotics");
  });
  it("collapses punctuation runs and trims edge hyphens", () => {
    expect(slugify("  Dresden! ")).toBe("dresden");
    expect(slugify("Auvergne-Rhone-Alpes")).toBe("auvergne-rhone-alpes");
  });
  it("keeps an already-clean single token", () => {
    expect(slugify("PulseStream")).toBe("pulsestream");
  });
  it("returns empty string for punctuation-only input", () => {
    expect(slugify("  -- ")).toBe("");
  });
});

describe("HeuristicEntityTagger", () => {
  const tagger = new HeuristicEntityTagger();

  it("extracts multi-word and single-word entities, dropping role words", () => {
    expect(tagger.tag("Alice Chen is the CTO of Nimbus Robotics.")).toEqual([
      "alice-chen",
      "nimbus-robotics",
    ]);
  });
  it("extracts the bridge entities of an HQ fact", () => {
    expect(tagger.tag("Nimbus Robotics is headquartered in Dresden.")).toEqual([
      "dresden",
      "nimbus-robotics",
    ]);
  });
  it("drops sentence-initial stopwords (The) and keeps the product/company", () => {
    expect(tagger.tag("The flagship product of Lumen Media is the PulseStream platform.")).toEqual([
      "lumen-media",
      "pulsestream",
    ]);
  });
  it("returns [] when there are no capitalized spans", () => {
    expect(tagger.tag("the lowercase only sentence has no entities")).toEqual([]);
  });
  it("deduplicates repeated mentions", () => {
    expect(tagger.tag("Dresden borders Dresden")).toEqual(["dresden"]);
  });
  it("trims a leading role word so the slug links with the plain name", () => {
    expect(tagger.tag("CEO Jane Doe leads the company.")).toEqual(["jane-doe"]);
  });
});
