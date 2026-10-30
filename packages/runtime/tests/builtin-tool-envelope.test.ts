import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { defaultSessionSeats } from "@covel/shared";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  createDefaultToolRegistry,
  createMemoryTools,
  FRAMEWORK_TOOL_NAMES,
} from "@covel/tools";
import {
  createToolExecutor,
  type ToolCallContext,
} from "../src/agent-loop/tool-executor.js";

const cases: Record<string, Record<string, unknown>> = {
  "render-ui": { parts: [{ id: "card", type: "text", content: "Hello" }] },
  "create-form": {
    formId: "form",
    title: "Name",
    submitLabel: "Continue",
    narrativeTemplate: "{{name}} arrives.",
    fields: [
      {
        name: "name",
        type: "text",
        label: "Name",
        required: true,
        placeholder: "Your name",
        defaultValue: "Ada",
      },
    ],
    validation: { name: "unique-name", data: { minimum: 2 } },
    submitBehavior: { echoFilledNarrative: false },
    notice: "Check your name.",
    actionKind: "say",
  },
  "create-choices": {
    choiceId: "choice",
    prompt: "Go?",
    choices: [
      { id: "go", label: "Go", description: "Leave now", category: "safe" },
      { id: "stay", label: "Stay" },
    ],
    actionKind: "say",
  },
  "create-notification": { level: "info", title: "Update", message: "Hello" },
  "emit-event": { topic: "changed", data: {} },
  "world-dimension-get": { queries: [{ dimension: "gold" }] },
  "world-dimension-list": {},
  "memory-search": { query: "Ada" },
  "plugin-data-set": { namespace: "notes", key: "k", value: 1 },
  "plugin-data-set-batch": {
    items: [{ namespace: "notes", key: "k", value: 1 }],
  },
  "plugin-data-get": { namespace: "notes", key: "k" },
  "plugin-data-list": { namespace: "notes" },
  "create-character": { name: "Wren", type: "npc" },
  "update-character": { id: "Ada", fields: { hp: 3 } },
  "sync-characters": { creates: [{ name: "Wren", type: "npc" }] },
  "list-characters": {},
  "get-character": { name: "Ada" },
  "get-character-schema": {},
  "runtime-done": {},
};
const expectedUI: Record<string, unknown> = {
  "render-ui": {
    rendered: true,
    ui: [
      {
        parts: [
          { id: "card", type: "text", status: "success", content: "Hello" },
        ],
      },
    ],
  },
  "create-form": {
    created: true,
    formId: "form",
    fieldCount: 1,
    interaction: {
      type: "form",
      interactionId: "form",
      title: "Name",
      fields: [
        {
          name: "name",
          type: "text",
          label: "Name",
          required: true,
          placeholder: "Your name",
          defaultValue: "Ada",
        },
      ],
      validation: { name: "unique-name", data: { minimum: 2 } },
      submitLabel: "Continue",
      narrativeTemplate: "{{name}} arrives.",
      submitBehavior: { echoFilledNarrative: false },
      notice: "Check your name.",
      actionKind: "say",
    },
  },
  "create-choices": {
    created: true,
    choiceId: "choice",
    choiceCount: 2,
    interaction: {
      type: "choice",
      interactionId: "choice",
      prompt: "Go?",
      choices: [
        { id: "go", label: "Go", description: "Leave now", category: "safe" },
        { id: "stay", label: "Stay" },
      ],
      actionKind: "say",
    },
  },
  "create-notification": {
    notified: true,
    level: "info",
    ui: [
      {
        parts: [
          {
            id: "notification-1",
            type: "notification",
            status: "success",
            content: {
              type: "Alert",
              props: { level: "info", title: "Update", message: "Hello" },
            },
          },
        ],
      },
    ],
  },
};
// Suspend is consumed before model rendering; delegate and search-tools have dedicated executor paths.
const excluded = ["suspend", "delegate", "search-tools"];

describe("builtin tool envelopes", () => {
  it("covers every reserved builtin", () => {
    expect([...Object.keys(cases), ...excluded].sort()).toEqual(
      [...FRAMEWORK_TOOL_NAMES].sort(),
    );
  });
  it.each(Object.entries(cases))(
    "renders %s without changing code-facing content",
    async (name, args) => {
      const store = createMemoryStore();
      await store.createSession({
        id: "s",
        locale: "en",
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        seats: defaultSessionSeats(),
        activePlugins: ["p"],
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      });
      await store.upsertCharacter({
        id: "ada",
        sessionId: "s",
        name: "Ada",
        type: "npc",
        version: 1,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      });
      const registry = createDefaultToolRegistry({
        store,
        eventDirectory: {
          listTopics: async () => ["changed"],
          validate: async () => ({ ok: true }),
        },
      });
      for (const module of createMemoryTools({ search: async () => [] }))
        registry.registerBuiltin(module);
      expect([...registry.builtinTools.keys()].sort()).toEqual(
        [...Object.keys(cases), "suspend", "delegate"].sort(),
      );
      const module = registry.find(name, "p");
      if (!module) throw new Error(`Missing builtin: ${name}`);
      const context: ToolCallContext = {
        sessionId: "s",
        turnId: "t",
        pluginId: "p",
        runtimeId: "p/r",
        locale: "en",
        world: {
          ...(await createWorldModelView(store, "s")),
          dimensions: {
            gold: {
              name: "Gold",
              schema: { type: "number" },
              value: 12,
              version: 1,
            },
          },
        },
      };
      const executor = createToolExecutor({
        store,
        findTool: (key) => registry.find(key, "p"),
      });
      try {
        const result = await executor.execute(
          { toolCallId: "c", name, arguments: JSON.stringify(args) },
          context,
        );
        expect(result.success, result.result).toBe(true);
        const envelope = JSON.parse(result.result);
        const keys = Object.keys(envelope);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys).toEqual(
          ["summary", "data", "staged"].filter((key) => keys.includes(key)),
        );
        expect(result.result).not.toMatch(/"_text"|"success"/);
        if (
          [
            "plugin-data-set",
            "plugin-data-set-batch",
            "create-character",
            "update-character",
            "sync-characters",
            "emit-event",
          ].includes(name)
        )
          expect(envelope.staged.count).toBeGreaterThanOrEqual(1);
        if (Object.hasOwn(expectedUI, name)) {
          expect(result.parsedResult).toEqual(expectedUI[name]);
          expect(envelope).toEqual({ summary: expect.any(String) });
        }
      } finally {
        await executor.close();
      }
    },
  );
});
