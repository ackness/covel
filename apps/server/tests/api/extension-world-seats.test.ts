/**
 * Extension providers that run outside a turn — the image-flow resolver and
 * history compaction — see the session's stored seats on `ctx.world`, so the
 * documented `primarySeat(ctx.world.seats)` works for them too.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PluginExtensionHost,
  PluginServiceRegistry,
  type LLMAdapter,
} from "@covel/runtime";
import {
  currentCharacterOf,
  primarySeat,
  type Seat,
  type WorldModelView,
} from "@covel/shared";
import type { DataStore, TurnMessageRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { makeSession } from "../../../../packages/store/src/contract/test-fixtures.js";
import {
  CompactionFailureTracker,
  createBootstrapCompactorRunner,
} from "../../src/routes/api/bootstrap/compactor.js";
import { resolveMediaImageFlow } from "../../src/routes/api/media-image-flow.js";

const AT = "2026-10-29T00:00:00.000Z";
const SEATS: Seat[] = [
  {
    id: "lead",
    controller: "human",
    role: "player",
    characters: ["ada", "lin"],
    currentCharacterId: "lin",
  },
  { id: "table", controller: "empty", role: "host", characters: "auto" },
];

async function seededStore(): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession(makeSession({ id: "session-1", seats: SEATS }));
  for (const [id, name] of [
    ["ada", "Ada"],
    ["lin", "Lin"],
  ] as const)
    await store.upsertCharacter({
      id,
      sessionId: "session-1",
      name,
      type: "player",
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  return store;
}

function hostFor(pluginId: string) {
  const services = new PluginServiceRegistry({
    list: async () => [pluginId],
    ensure: async () => {},
  });
  return new PluginExtensionHost(services);
}

function currentOf(world: WorldModelView): string | undefined {
  const seat = primarySeat(world.seats);
  return seat
    ? currentCharacterOf(seat, world.characters, world.seats)?.id
    : undefined;
}

describe("extension providers outside a turn read the stored seats", () => {
  it("passes the seats to an image-flow provider", async () => {
    const store = await seededStore();
    const host = hostFor("pictures");
    const seen: { seats?: readonly Seat[]; current?: string } = {};
    host.register(
      "pictures",
      { point: "media.image-flow@1", id: "flow" },
      {
        handler: (_input, ctx) => {
          seen.seats = ctx.world.seats;
          seen.current = currentOf(ctx.world as WorldModelView);
          return { entryRuntimeId: "pictures", assetRuntimeIds: ["pictures"] };
        },
      },
    );
    try {
      await expect(
        resolveMediaImageFlow(store, host, "session-1"),
      ).resolves.toMatchObject({ entryRuntimeId: "pictures" });
      expect(seen.seats).toEqual(SEATS);
      expect(seen.current).toBe("lin");
    } finally {
      await store.close();
    }
  });

  it("passes the seats to a history compaction provider", async () => {
    const store = await seededStore();
    const host = hostFor("summaries");
    const seen: { seats?: readonly Seat[]; current?: string } = {};
    host.register(
      "summaries",
      { point: "history.compact@2", id: "summary" },
      {
        handler: (_input, ctx) => {
          seen.seats = ctx.world.seats;
          seen.current = currentOf(ctx.world as WorldModelView);
          return null;
        },
      },
    );
    const llmAdapter: LLMAdapter = {
      generate: vi.fn(async () => {
        throw new Error("not called");
      }),
      resolveBudget: () => ({ contextWindow: 1_000, maxOutputTokens: 200 }),
    };
    const runner = createBootstrapCompactorRunner({
      extensions: host,
      store,
      llmAdapter,
      failures: new CompactionFailureTracker(),
    });
    const message: TurnMessageRecord = {
      id: "history",
      sessionId: "session-1",
      turnId: "turn-1",
      role: "user",
      sourceType: "player",
      order: 0,
      content: "x".repeat(2_000),
      createdAt: AT,
    };
    try {
      await runner.run("session-1", "", [message], "en-US");
      expect(seen.seats).toEqual(SEATS);
      expect(seen.current).toBe("lin");
    } finally {
      await store.close();
    }
  });
});
