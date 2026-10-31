import { expect, it } from "vitest";
import { PROPOSAL_TYPES, proposalPayloadSchemas } from "../src/index.js";
import type { ProposalFor, ProposalReadPrecondition } from "../src/index.js";

it("keeps host read conditions on the envelope and out of authored operation payloads", () => {
  const condition: ProposalReadPrecondition = {
    kind: "plugin-data",
    pluginId: "p",
    namespace: "data",
    key: "record",
    basis: { exists: false },
  };
  const proposal: ProposalFor<"plugin.data"> = {
    id: "p",
    sessionId: "s",
    turnId: "t",
    timestamp: "now",
    source: { pluginId: "p", runtimeId: "r" },
    type: "plugin.data",
    payload: { namespace: "data", key: "record", value: null },
    preconditions: [condition],
  };
  expect(proposal.payload).not.toHaveProperty("preconditions");
  expect(
    proposalPayloadSchemas["plugin.data.update"].safeParse({
      namespace: "data",
      key: "record",
      ops: [{ op: "set", value: null, preconditions: [condition] }],
    }).success,
  ).toBe(false);
});

it("does not expose a session-state write proposal", () => {
  expect(PROPOSAL_TYPES).not.toContain("state.patch");
  expect(proposalPayloadSchemas).not.toHaveProperty("state.patch");
});

it("lists plugin.data.update with a payload schema of namespace, key and ops", () => {
  expect(PROPOSAL_TYPES).toContain("plugin.data.update");
  const schema = proposalPayloadSchemas["plugin.data.update"];
  expect(
    schema.safeParse({
      namespace: "wallet",
      key: "gold",
      ops: [{ op: "inc", by: -3, min: 0 }],
    }).success,
  ).toBe(true);
  const invalid: readonly unknown[] = [
    { namespace: "wallet", key: "gold", ops: [] },
    {
      namespace: "wallet",
      key: "gold",
      ops: Array.from({ length: 65 }, () => ({ op: "inc", by: 1 })),
    },
    { namespace: "wallet", key: "gold", ops: [{ op: "swap" }] },
    { namespace: "wallet", key: "gold", ops: [{ op: "inc", by: Infinity }] },
    { namespace: "", key: "gold", ops: [{ op: "delete" }] },
  ];
  for (const payload of invalid)
    expect(schema.safeParse(payload).success).toBe(false);
});
