import { describe, it, expect } from "vitest";
import { EntityIndex } from "../../src/memory/entity-index.js";

describe("EntityIndex", () => {
  it("maps a slug to the node ids that mention it (insertion order)", () => {
    const idx = new EntityIndex();
    idx.add("n1", ["nimbus-robotics", "dresden"]);
    idx.add("n2", ["nimbus-robotics"]);
    expect(idx.lookup("nimbus-robotics")).toEqual(["n1", "n2"]);
    expect(idx.lookup("dresden")).toEqual(["n1"]);
    expect(idx.lookup("absent")).toEqual([]);
  });
  it("is idempotent — re-adding the same (slug,node) does not duplicate", () => {
    const idx = new EntityIndex();
    idx.add("n1", ["dresden"]);
    idx.add("n1", ["dresden"]);
    expect(idx.lookup("dresden")).toEqual(["n1"]);
  });
  it("records the slugs of a node and counts distinct slugs", () => {
    const idx = new EntityIndex();
    idx.add("n1", ["nimbus-robotics", "dresden"]);
    idx.add("n2", ["saxony"]);
    expect(idx.slugsOf("n1").sort()).toEqual(["dresden", "nimbus-robotics"]);
    expect(idx.slugCount).toBe(3);
  });
});
