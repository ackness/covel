/**
 * Every proposal is checked before its commit handler runs (audit F-152,
 * F-163): its payload against the schema of its type, and every MediaRef in
 * it against the session. A failure is a rejected proposal — an optional
 * runtime next to a story is dropped alone, a story-less execution commits
 * nothing — never a store error that rolls the whole execution back.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  PROPOSAL_TYPES,
  checkProposalPayload,
  proposalPayloadSchemas,
  type JsonValue,
  type Proposal,
  type ProposalType,
  type RuntimeEffects,
  type RuntimeManifest,
} from "@covel/shared";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import type { MediaOwnershipStore } from "../src/media/canonicalize-media-refs.js";

const SESSION_ID = "sess-check";
const TURN_ID = "turn-check";

function runtime(
  name: string,
  outputKind: RuntimeManifest["outputKind"] = "system",
): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    stage: "post-turn",
    outputKind,
  };
}

function result(
  runtimeId: string,
  output: Record<string, unknown> = {},
  extra: {
    readonly effects?: RuntimeEffects;
    readonly pendingProposals?: readonly Proposal[];
  } = {},
) {
  return {
    pluginId: runtimeId,
    runtimeId,
    runId: crypto.randomUUID(),
    turnId: TURN_ID,
    status: "success" as const,
    output,
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/** A proposal as a `.js` tool can hand it over: any payload at all. */
function rawProposal(type: ProposalType, payload: unknown): Proposal {
  return {
    id: crypto.randomUUID(),
    type,
    source: { pluginId: "sibling", runtimeId: "sibling" },
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    payload,
    timestamp: new Date().toISOString(),
  } as Proposal;
}

async function pendingTurn(store: DataStore): Promise<void> {
  await store.saveTurnResult({
    id: crypto.randomUUID(),
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    runtimeResults: [],
    origin: "player",
    commitStatus: "pending",
    durationMs: 1,
    createdAt: new Date().toISOString(),
  });
}

const context = (origin: "player" | "manual") => ({
  executionId: crypto.randomUUID(),
  origin,
  countPolicy: "none" as const,
});

describe("proposal payload schemas", () => {
  it("has one schema for every proposal type", () => {
    expect(Object.keys(proposalPayloadSchemas).sort()).toEqual(
      [...PROPOSAL_TYPES].sort(),
    );
  });

  it("passes on the JSON copy and rejects what JSON cannot hold", () => {
    expect(
      checkProposalPayload("plugin.data", {
        namespace: "n",
        key: "k",
        value: { kept: 1, dropped: undefined, at: new Date(0) },
      }),
    ).toEqual({
      ok: true,
      payload: {
        namespace: "n",
        key: "k",
        value: { kept: 1, at: "1970-01-01T00:00:00.000Z" },
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [10n, circular]) {
      const checked = checkProposalPayload("plugin.data", {
        namespace: "n",
        key: "k",
        value,
      });
      expect(checked).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^plugin\.data: payload is not JSON/),
      });
    }
    expect(
      checkProposalPayload("narrative.append", { kind: "system" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^narrative\.append: invalid payload/),
    });
  });
});

describe("finalizeExecution checks every proposal before it commits", () => {
  it.each([
    [
      "a narrative without content",
      rawProposal("narrative.append", { kind: "system" }),
    ],
    [
      "a plugin-data value JSON cannot hold",
      rawProposal("plugin.data", { namespace: "n", key: "k", value: 1n }),
    ],
    [
      "an interaction without an id",
      rawProposal("interaction.request", { type: "form", data: {} }),
    ],
  ])(
    "drops only the optional runtime that handed over %s",
    async (_label, proposal) => {
      const store = createMemoryStore();
      await pendingTurn(store);
      const outcome = await finalizeExecution({
        store,
        sessionId: SESSION_ID,
        executionContext: context("player"),
        runtimes: [runtime("story", "story"), runtime("sibling")],
        results: [
          result("story", { narrativeOutput: "The gate creaks open." }),
          result("sibling", {}, { pendingProposals: [proposal] }),
        ],
        turnIds: [TURN_ID],
      });

      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [{ runtimeId: "sibling" }],
      });
      expect(outcome.failedProposals).toEqual([
        expect.objectContaining({ code: "proposal-invalid" }),
      ]);
      expect(
        (await store.listMessages(SESSION_ID)).map((m) => m.content),
      ).toEqual(["The gate creaks open."]);
      expect(await store.listPluginData(SESSION_ID, "sibling", "n")).toEqual(
        [],
      );
      await store.close();
    },
  );

  describe("MediaRefs", () => {
    const own = { id: "a".repeat(64), mime: "image/webp", size: 10 };
    const foreign = {
      id: "b".repeat(64),
      mime: "image/webp",
      size: 10,
    };
    const mediaStore: MediaOwnershipStore = {
      async lookup(id) {
        return id === own.id || id === foreign.id
          ? { mime: "image/webp", size: 42 }
          : null;
      },
      async isReferencedBy(id, sessionId) {
        return id === own.id && sessionId === SESSION_ID;
      },
    };
    const picture = (ref: JsonValue): RuntimeEffects => ({
      assetGenerations: [{ ref, modality: "image" }],
      pluginData: [{ namespace: "gallery", key: "latest", value: { ref } }],
    });

    it("refuses a ref the session does not hold and commits nothing", async () => {
      const store = createMemoryStore();
      await pendingTurn(store);
      const outcome = await finalizeExecution({
        store,
        mediaStore,
        sessionId: SESSION_ID,
        executionContext: context("manual"),
        runtimes: [runtime("painter")],
        results: [result("painter", {}, { effects: picture(foreign) })],
        turnIds: [TURN_ID],
      });

      expect(outcome.status).toBe("failed");
      expect(outcome.failedProposals).toContainEqual(
        expect.objectContaining({ code: "media-ownership-invalid" }),
      );
      expect(await store.listMessages(SESSION_ID)).toEqual([]);
      expect(
        await store.listPluginData(SESSION_ID, "painter", "gallery"),
      ).toEqual([]);
      await store.close();
    });

    it("stores the canonical ref: the store's size and no url", async () => {
      const store = createMemoryStore();
      await pendingTurn(store);
      const outcome = await finalizeExecution({
        store,
        mediaStore,
        sessionId: SESSION_ID,
        executionContext: context("manual"),
        runtimes: [runtime("painter")],
        results: [
          result(
            "painter",
            {},
            {
              effects: picture({ ...own, url: "https://cdn.example/x.webp" }),
            },
          ),
        ],
        turnIds: [TURN_ID],
      });

      expect(outcome.status).toBe("committed");
      const canonical = { id: own.id, mime: "image/webp", size: 42 };
      const [message] = await store.listMessages(SESSION_ID);
      expect(
        (message?.metadata as { block?: { data?: { ref?: unknown } } })?.block
          ?.data?.ref,
      ).toEqual(canonical);
      const [row] = await store.listPluginData(
        SESSION_ID,
        "painter",
        "gallery",
      );
      expect(row?.value).toEqual({ ref: canonical });
      await store.close();
    });
  });
});
