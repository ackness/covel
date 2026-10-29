import { expect, it } from "vitest";
import { PROPOSAL_TYPES, proposalPayloadSchemas } from "../src/index.js";

it("does not expose a session-state write proposal", () => {
  expect(PROPOSAL_TYPES).not.toContain("state.patch");
  expect(proposalPayloadSchemas).not.toHaveProperty("state.patch");
});
