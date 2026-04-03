import { describe, expect, it } from "vitest";
import { createStatePatchId } from "../src/routes/actions.js";

describe("createStatePatchId", () => {
  it("namespaces patch ids by turn id", () => {
    expect(createStatePatchId("turn-a", 0)).toBe("patch_turn-a_0");
    expect(createStatePatchId("turn-b", 0)).toBe("patch_turn-b_0");
  });

  it("keeps ids distinct across seq values within the same turn", () => {
    expect(createStatePatchId("turn-a", 1)).not.toBe(createStatePatchId("turn-a", 2));
  });
});
