/**
 * Design-principle gates: removing all plugins leaves the framework functional
 * (zero-plugin gate), and one narrative plugin is enough to play
 * (narrative-only gate). Both run against the real bundled plugin directory
 * with a scripted model; no network and no real model calls.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { parseJsonFrames } from "./sse-test-utils.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

interface PackEntry {
  readonly id: string;
  readonly requested?: readonly string[];
  readonly excluded?: readonly string[];
}

/** The player-selectable plugin set of a curated pack, read as data. */
function packSelection(packId: string): {
  plugins: string[];
  excludedPlugins: string[];
} {
  const doc = parseYaml(
    readFileSync(path.join(REPO_ROOT, "packs/builtin.yaml"), "utf8"),
  ) as { packs?: PackEntry[] } | PackEntry[];
  const packs = Array.isArray(doc) ? doc : (doc.packs ?? []);
  const pack = packs.find((item) => item.id === packId);
  if (!pack?.requested?.length) throw new Error(`pack ${packId} not found`);
  return {
    plugins: [...pack.requested],
    excludedPlugins: [...(pack.excluded ?? [])],
  };
}

const STORY_TEXT = "Rain taps the lantern glass while the road bends north.";

type Frame = { type: string; payload: Record<string, unknown> };

describe("plugin floor gates", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  const generate = vi.fn(async (): Promise<LLMResponse> => ({
    content: STORY_TEXT,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));

  beforeAll(async () => {
    boot = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: { generate } as LLMAdapter,
      canRunRuntimeJobWithServerServices: () => true,
      pluginGateway: {
        async generateText() {
          return {
            text: "{}",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
        async generateObject() {
          throw new Error("generateObject is not expected in this flow");
        },
        resolveSlot: () => null,
      },
      store: createMemoryStore(),
      storeBackend: "memory",
    });
  });

  afterAll(async () => {
    await closeTestApi(boot);
    await boot?.store.close();
  });

  const post = (url: string, body: unknown) =>
    boot.app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const action = (sessionId: string, type: string, payload: unknown) =>
    post("/api/actions", {
      requestId: crypto.randomUUID(),
      sessionId,
      type,
      payload,
    });

  it("zero-plugin gate: an empty plugin set rejects start cleanly and settles player turns", async () => {
    expect(boot.registry.getAll().size).toBeGreaterThan(0);
    generate.mockClear();

    const created = await post("/api/sessions", {
      plugins: [],
      excludedPlugins: [...boot.registry.getAll().keys()],
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    expect(session).toMatchObject({ activePlugins: [], phase: "playing" });

    // Starting with no plugins is an explained client error, not a crash.
    const start = await action(session.id, "start_session", {});
    expect(start.status).toBe(400);
    expect(await start.json()).toMatchObject({ code: "no_active_plugins" });

    // Player messages settle as an empty committed execution, twice: the
    // session stays usable after the first one.
    for (const expectedTurns of [1, 2]) {
      const turn = await action(session.id, "submit_actions", {
        actions: [{ kind: "say", text: "Look around." }],
      });
      expect(turn.status).toBe(200);
      const events = parseJsonFrames<Frame>(await turn.text());
      expect(
        events.find((event) => event.type === "execution.completed"),
      ).toMatchObject({
        payload: { runtimeCount: 0, resultCount: 0, committed: true },
      });
      expect(
        events.filter(
          (event) =>
            event.type === "error.occurred" || event.type === "runtime.failed",
        ),
      ).toEqual([]);
      expect(
        (await boot.store.getSession(session.id))?.completedPlayerTurns,
      ).toBe(expectedTurns);
    }

    const read = await boot.app.request(`/api/sessions/${session.id}`);
    expect(read.status).toBe(200);
    expect(generate).not.toHaveBeenCalled();
  });

  it("narrative-only gate: the narrative-only pack's plugin set commits a story message", async () => {
    generate.mockClear();
    const { plugins: requested, excludedPlugins } =
      packSelection("narrative-only");
    const created = await post("/api/sessions", {
      plugins: requested,
      excludedPlugins,
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as {
      id: string;
      activePlugins: string[];
    };
    expect([...session.activePlugins].sort()).toEqual([...requested].sort());

    const turn = await action(session.id, "submit_actions", {
      actions: [{ kind: "say", text: "Walk north." }],
    });
    expect(turn.status).toBe(200);
    const events = parseJsonFrames<Frame>(await turn.text());
    expect(events.map((event) => event.type)).not.toContain("error.occurred");
    expect(
      events.find((event) => event.type === "execution.completed"),
    ).toMatchObject({ payload: { committed: true } });

    expect(generate).toHaveBeenCalled();
    // The player-visible story message, not just the runtime journal.
    const stored = await boot.store.listMessages(session.id);
    const story = stored.filter(
      (message) =>
        message.role === "assistant" &&
        (message.metadata as { kind?: string } | undefined)?.kind === "story",
    );
    expect(story.map((message) => message.content.trim())).toEqual([
      STORY_TEXT.trim(),
    ]);
    const journal = await boot.store.listTurnMessages(session.id);
    expect(
      journal.some((message) => message.content.includes(STORY_TEXT)),
    ).toBe(true);
    expect(
      (await boot.store.getSession(session.id))?.completedPlayerTurns,
    ).toBe(1);
  });
});
