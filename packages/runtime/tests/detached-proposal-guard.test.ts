/**
 * The detached commit boundary re-checks every proposal against the runtime's
 * declared writes: a static manifest check is not a security boundary.
 */

import { describe, expect, it } from "vitest";
import type {
  Proposal,
  ProposalPayloadMap,
  ProposalType,
  RuntimeManifest,
} from "@covel/shared";
import { createDetachedProposalGuard } from "../src/schedule/turn-completion.js";

const manifest: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

function proposal<K extends ProposalType>(
  type: K,
  payload: ProposalPayloadMap[K],
): Proposal {
  return {
    id: crypto.randomUUID(),
    type,
    source: { pluginId: "notes", runtimeId: "notes/extract" },
    sessionId: "s",
    turnId: "t",
    payload,
    timestamp: "2026-10-29T00:00:00.000Z",
  } as Proposal;
}

describe("createDetachedProposalGuard", () => {
  const guard = createDetachedProposalGuard(manifest);
  const update = (namespace: string) =>
    proposal("plugin.data.update", {
      namespace,
      key: "k",
      ops: [{ op: "inc", by: 1 }],
    });

  it("accepts plugin.data.update into a declared namespace", () => {
    expect(guard(update("notes"))).toBeUndefined();
  });

  it("rejects plugin.data.update into an undeclared namespace", () => {
    expect(guard(update("other"))).toBe(
      "detached runtime emitted undeclared plugin-data namespace other",
    );
  });

  it("rejects plugin.data.update into a framework-reserved namespace", () => {
    expect(guard(update("_hidden.notes"))).toBe(
      "detached runtime cannot write framework-reserved plugin data",
    );
  });

  it("allows every namespace under plugin-data:self:*", () => {
    const wide = createDetachedProposalGuard({
      ...manifest,
      effects: { writes: ["plugin-data:self:*"] },
    });
    expect(wide(update("anything"))).toBeUndefined();
  });

  it("applies the same rule to plugin.data and still refuses plugin.data.delete", () => {
    expect(
      guard(
        proposal("plugin.data", { namespace: "notes", key: "k", value: 1 }),
      ),
    ).toBeUndefined();
    expect(
      guard(proposal("plugin.data.delete", { namespace: "notes", key: "k" })),
    ).toBe(
      "proposal type plugin.data.delete is not allowed for a detached stage runtime",
    );
  });
});
