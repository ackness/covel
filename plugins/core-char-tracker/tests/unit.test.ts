import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
} from "@covel/plugin-test-utils";
import { validateManifest } from "@covel/plugin-runtime";
import type { CharacterCard, ToolExecutionContext } from "@covel/shared";
import { PLUGIN_ID } from "../server/logic.js";
import type { TrackerExtension } from "../server/logic.js";
import register from "../server/index.js";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Plugin Registration ───────────────────────────────────────────

describe("register", () => {
  it("registers upsert-character tool (no runtime handler)", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.tools.has("upsert-character")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
  });
});

// ── upsert-character tool ─────────────────────────────────────────

describe("upsert-character tool", () => {
  function getToolHandler() {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    return contributions.tools.get("upsert-character")!;
  }

  function makeCtx(
    input: Record<string, unknown>,
    state?: Record<string, unknown>,
  ): ToolExecutionContext {
    return {
      input,
      locale: "zh-CN",
      state: {
        worldId: "world_test",
        runId: "run_test",
        turnId: "turn_001",
        ...state,
      },
    } as ToolExecutionContext;
  }

  it("creates a new character card", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({
      name: "老艄公",
      description: "戴斗笠的摇橹老人",
      type: "npc",
    }));

    expect(result.output).toEqual(expect.objectContaining({
      name: "老艄公",
      isNew: true,
    }));

    expect(result.proposals).toBeDefined();
    const upsert = result.proposals!.find((p) => p.kind === "record.upsert") as
      { kind: string; payload: { key: string; value: { fields: CharacterCard } } } | undefined;
    expect(upsert).toBeDefined();
    expect(upsert!.payload.key).toBe("character:老艄公");

    const card = upsert!.payload.value.fields;
    expect(card.name).toBe("老艄公");
    expect(card.type).toBe("npc");
    expect(card.description).toBe("戴斗笠的摇橹老人");
    expect(card.version).toBe(1);

    const ext = card.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(1);
    expect(ext.firstSeenTurn).toBe("turn_001");
  });

  it("updates an existing character card", async () => {
    const handler = getToolHandler();
    const existingCard: CharacterCard = {
      id: "char_001",
      worldId: "world_test",
      runId: "run_test",
      name: "老艄公",
      type: "npc",
      description: "一个老人",
      fields: {},
      extensions: {
        [PLUGIN_ID]: {
          firstSeenTurn: "turn_000",
          lastSeenTurn: "turn_000",
          mentionCount: 2,
        } satisfies TrackerExtension,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      version: 3,
    };

    const result = await handler(makeCtx(
      {
        name: "老艄公",
        description: "戴斗笠的摇橹老人，声音沙哑",
        type: "npc",
      },
      { characters: { "老艄公": existingCard } },
    ));

    expect(result.output).toEqual(expect.objectContaining({
      name: "老艄公",
      isNew: false,
    }));

    const upsert = result.proposals!.find((p) => p.kind === "record.upsert") as
      { kind: string; payload: { key: string; value: { fields: CharacterCard } } } | undefined;
    const card = upsert!.payload.value.fields;
    expect(card.version).toBe(4);
    expect(card.description).toBe("戴斗笠的摇橹老人，声音沙哑");

    const ext = card.extensions[PLUGIN_ID] as TrackerExtension;
    expect(ext.mentionCount).toBe(3);
    expect(ext.firstSeenTurn).toBe("turn_000");
    expect(ext.lastSeenTurn).toBe("turn_001");
  });

  it("sanitizes fields against schema when available", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx(
      {
        name: "李明",
        description: "年轻剑客",
        type: "npc",
        fields: { hp: 100, faction: "云梦泽", invalidField: "should be removed" },
      },
      {
        characterFieldSchema: {
          worldId: "world_test",
          fields: [
            { key: "hp", label: "生命值", type: "number" },
            { key: "faction", label: "阵营", type: "string" },
          ],
        },
      },
    ));

    const upsert = result.proposals!.find((p) => p.kind === "record.upsert") as
      { kind: string; payload: { value: { fields: CharacterCard } } } | undefined;
    const card = upsert!.payload.value.fields;
    expect(card.fields).toEqual({ hp: 100, faction: "云梦泽" });
  });

  it("passes through all fields when no schema is defined", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({
      name: "李明",
      description: "年轻剑客",
      type: "npc",
      fields: { hp: 100, faction: "云梦泽", custom: "value" },
    }));

    const upsert = result.proposals!.find((p) => p.kind === "record.upsert") as
      { kind: string; payload: { value: { fields: CharacterCard } } } | undefined;
    const card = upsert!.payload.value.fields;
    expect(card.fields).toEqual({ hp: 100, faction: "云梦泽", custom: "value" });
  });

  it("rejects empty name", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({
      name: "",
      description: "描述",
      type: "npc",
    }));

    expect(result.output).toEqual(expect.objectContaining({
      error: expect.stringContaining("不能为空"),
    }));
    expect(result.proposals).toBeUndefined();
  });

  it("emits state.patch with full characters map", async () => {
    const handler = getToolHandler();
    const existingCard: CharacterCard = {
      id: "char_existing",
      worldId: "world_test",
      runId: "run_test",
      name: "老王",
      type: "npc",
      description: "一个老人",
      fields: {},
      extensions: {},
      createdAt: "2024-01-01T00:00:00.000Z",
      version: 1,
    };

    const result = await handler(makeCtx(
      {
        name: "李明",
        description: "年轻剑客",
        type: "npc",
      },
      { characters: { "老王": existingCard } },
    ));

    const statePatch = result.proposals!.find((p) => p.kind === "state.patch") as
      { kind: string; payload: { characters: Record<string, CharacterCard> } } | undefined;
    expect(statePatch).toBeDefined();
    expect(statePatch!.payload.characters["老王"]).toBeDefined();
    expect(statePatch!.payload.characters["李明"]).toBeDefined();
  });
});
