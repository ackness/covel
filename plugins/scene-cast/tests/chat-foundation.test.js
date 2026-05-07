import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { scheduleByDag } from "@covel/runtime";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

describe("chat foundation manifests", () => {
  let sceneCast;
  let chatNarrator;
  let loadedSceneCast;
  let loadedChatNarrator;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const byId = new Map(
      discoveries.map((discovery) => [discovery.id, discovery]),
    );

    const sceneCastDiscovery = byId.get("scene-cast");
    const chatNarratorDiscovery = byId.get("chat-mode-narrator");
    expect(sceneCastDiscovery).toBeDefined();
    expect(chatNarratorDiscovery).toBeDefined();

    sceneCast = (await loadPluginManifest(sceneCastDiscovery))[0].manifest;
    chatNarrator = (await loadPluginManifest(chatNarratorDiscovery))[0]
      .manifest;
    loadedSceneCast = await loadRuntime(sceneCastDiscovery, sceneCast.name);
    loadedChatNarrator = await loadRuntime(
      chatNarratorDiscovery,
      chatNarrator.name,
    );
  });

  it("loads scene-cast as a function runtime before chat-mode-narrator", () => {
    expect(sceneCast).toMatchObject({
      name: "scene-cast",
      pluginType: "plugin",
      runtimeType: "function",
      handler: "./handler.js",
      priority: 450,
      outputKind: "system",
    });
    expect(sceneCast.capabilities).toContain("scene-cast");
    expect(sceneCast.trigger).toMatchObject({ type: "scheduled", interval: 1 });
    expect(loadedSceneCast.handler).toBeTypeOf("function");
    expect(loadedSceneCast.uiSpecs.right).toHaveLength(1);
  });

  it("loads chat-mode-narrator with active cast runtime injection", () => {
    expect(chatNarrator).toMatchObject({
      name: "chat-mode-narrator",
      pluginType: "plugin",
      priority: 500,
      outputKind: "story",
      model: "story",
      promptVersion: 2,
    });
    expect(chatNarrator.capabilities).toEqual(
      expect.arrayContaining(["narrative", "chat-mode"]),
    );
    expect(chatNarrator.input.inject[0]).toMatchObject({
      kind: "runtime",
      from: "scene-cast",
      field: "activeCastContext",
      as: "<active-cast>",
    });
    expect(chatNarrator.summaryFocus).toEqual([
      "character-intent",
      "relationship-change",
      "emotional-hook",
    ]);
    expect(loadedChatNarrator.promptTemplate).toContain(
      "{{ inputs.scene-cast.scene-cast.activeCastContext }}",
    );
  });

  it("schedules scene-cast before chat-mode-narrator in the DAG runtime layer", () => {
    const { groups, error } = scheduleByDag([
      sceneCast,
      chatNarrator,
      {
        name: "guide",
        pluginId: "guide",
        priority: 600,
        input: {
          inject: [
            {
              kind: "runtime",
              from: "chat-mode-narrator",
              field: "narrativeOutput",
              as: "<narrator-output>",
            },
          ],
        },
      },
    ]);

    expect(error).toBeUndefined();
    expect(
      groups.map((group) => group.runtimes.map((runtime) => runtime.name)),
    ).toEqual([["scene-cast"], ["chat-mode-narrator"], ["guide"]]);
  });
});

describe("scene-cast handler", () => {
  it("selects mentioned NPCs and writes active cast plugin data", async () => {
    const store = {
      async listCharacters(sessionId) {
        expect(sessionId).toBe("sess-chat");
        return [
          {
            id: "player-1",
            name: "Player",
            type: "player",
            description: "The player character",
          },
          {
            id: "npc-1",
            name: "Mira",
            type: "npc",
            description: "A wary smuggler with a soft voice",
            fields: { mood: "guarded" },
          },
          {
            id: "npc-2",
            name: "Sol",
            type: "npc",
            description: "A temple archivist",
          },
        ];
      },
      async listTurnMessages(sessionId, opts) {
        expect(sessionId).toBe("sess-chat");
        expect(opts.limit).toBe(12);
        return [
          {
            content:
              "Mira studies the locked door while Sol waits near the altar.",
          },
        ];
      },
      async getPluginData() {
        return null;
      },
    };

    const result = await handler({
      sessionId: "sess-chat",
      turnId: "turn-7",
      pluginId: "scene-cast",
      runtimeId: "scene-cast",
      playerMessage: "Mira, what do you see?",
      store,
      completedResults: new Map(),
      config: {},
      recursiveCall: async () => {
        throw new Error("unused");
      },
      recursionDepth: 0,
      userSettings: { activeSpeakerCount: 1 },
    });

    expect(result.speakers).toHaveLength(1);
    expect(result.speakers[0].name).toBe("Mira");
    expect(result.activeCastContext).toContain("Mira");

    const [proposal] = getPendingProposals(result);
    expect(proposal).toMatchObject({
      type: "plugin.data",
      sessionId: "sess-chat",
      turnId: "turn-7",
      source: { pluginId: "scene-cast", runtimeId: "scene-cast" },
      payload: {
        namespace: "active-cast",
        key: "current",
        value: {
          turnId: "turn-7",
          speakers: [
            expect.objectContaining({
              id: "npc-1",
              name: "Mira",
              signals: expect.arrayContaining(["mentioned by player"]),
            }),
          ],
        },
      },
    });
  });

  it("keeps active cast empty when NPCs only have profile data", async () => {
    const store = {
      async listCharacters() {
        return [
          { id: "player-1", name: "Player", type: "player" },
          {
            id: "npc-1",
            name: "Ari",
            type: "npc",
            description: "A quiet medic",
            fields: { mood: "calm" },
          },
          {
            id: "npc-2",
            name: "Bex",
            type: "npc",
            description: "A bright scout",
          },
        ];
      },
      async listTurnMessages() {
        return [{ content: "The empty corridor hums under pale light." }];
      },
      async getPluginData() {
        return null;
      },
    };

    const result = await handler({
      sessionId: "sess-chat",
      turnId: "turn-8",
      pluginId: "scene-cast",
      runtimeId: "scene-cast",
      playerMessage: "I listen at the door.",
      store,
      completedResults: new Map(),
      config: {},
      recursiveCall: async () => {
        throw new Error("unused");
      },
      recursionDepth: 0,
    });

    expect(result.speakers).toEqual([]);
    expect(result.activeCastContext).toContain("No active NPC selected");
  });
});
