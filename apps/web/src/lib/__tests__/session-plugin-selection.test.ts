// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PluginPack, PluginSummary, WorldPluginPlan } from "@covel/shared";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPlugins,
  groupPlugins,
  pluginTagLabel,
  recommendationReason,
} from "../session-plugin-selection.js";

function plugin(
  id: string,
  options: Partial<PluginSummary> = {},
): PluginSummary {
  return {
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    eventTopics: [],
    id,
    displayName: id,
    description: `${id} plugin`,
    kind: "plugin",
    source: "builtin",
    hostState: "loaded",
    runtimeCount: 0,
    provides: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
    ...options,
  };
}

const plugins = [
  plugin("pregame", { kind: "core", tags: ["role:pre-game"] }),
  plugin("narrator", {
    kind: "core",
    tags: ["mode:traditional-story", "role:narrator"],
    provides: ["narrative"],
  }),
  plugin("chat-mode-narrator", {
    tags: ["mode:dialogue", "role:narrator"],
    provides: ["narrative-engine@1", "chat-mode@1"],
  }),
  plugin("scene-cast", { tags: ["mode:dialogue"] }),
];

const dialoguePack: PluginPack = {
  id: "dialogue-mode",
  label: { "en-US": "Dialogue Mode", "zh-CN": "对话模式" },
  requested: ["chat-mode-narrator", "scene-cast"],
  recommended: [],
  tags: ["mode:dialogue"],
  source: "builtin",
};

const plan: WorldPluginPlan = {
  worldId: "world",
  packs: [dialoguePack],
  selectedPackId: dialoguePack.id,
  policy: {
    preset: dialoguePack.id,
    plus: ["pregame"],
    requires: [],
  },
  defaultPluginIds: ["pregame", "chat-mode-narrator", "scene-cast"],
  missing: [],
};

describe("session plugin selection helpers", () => {
  it("uses the server-resolved plan as the only default source", () => {
    expect([...defaultSelectedPluginIds(plan)]).toEqual(plan.defaultPluginIds);
  });

  it("applies packs while preserving locked plugins", () => {
    const selected = applyPluginPackSelection(
      new Set(["narrator"]),
      dialoguePack,
      plugins,
      new Set(["narrator"]),
    );
    expect([...selected]).toEqual(
      expect.arrayContaining(["narrator", "chat-mode-narrator", "scene-cast"]),
    );
  });

  it("filters and groups canonical plugin descriptors", () => {
    expect(collectPluginTags(plugins)).toContain("mode:dialogue");
    expect(
      filterPlugins(plugins, "chat", new Set(["mode:dialogue"])).map(
        (item) => item.id,
      ),
    ).toEqual(["chat-mode-narrator"]);
    expect(
      groupPlugins(plugins, (tag) => tag ?? "").map((group) => group.id),
    ).toContain("tag:mode:dialogue");
  });

  it("groups once by the first declared tag, regardless of kind or source", () => {
    const items = [
      plugin("custom", {
        kind: "core",
        source: "community",
        tags: ["mode:custom", "role:guide"],
      }),
      plugin("guide", { tags: ["role:guide", "mode:custom"] }),
      plugin("tagged", { tags: ["untagged"] }),
      plugin("plain", { kind: "core" }),
    ];
    expect(
      groupPlugins(items, (tag) => tag ?? "No tags").map(
        ({ id, label, plugins }) => ({
          id,
          label,
          ids: plugins.map((item) => item.id),
        }),
      ),
    ).toEqual([
      { id: "tag:mode:custom", label: "mode:custom", ids: ["custom"] },
      { id: "tag:role:guide", label: "role:guide", ids: ["guide"] },
      { id: "tag:untagged", label: "untagged", ids: ["tagged"] },
      { id: "untagged", label: "No tags", ids: ["plain"] },
    ]);
    expect(groupPlugins([], (tag) => tag ?? "No tags")).toEqual([]);
    expect(
      groupPlugins(
        filterPlugins(items, "plain", new Set()),
        (tag) => tag ?? "No tags",
      ),
    ).toHaveLength(1);
  });

  it("groups by the cost tag before the tags the author wrote", () => {
    const items = [
      plugin("talker", { tags: ["data:characters", "cost:llm"] }),
      plugin("counter", { tags: ["mode:dialogue", "cost:function"] }),
      plugin("panel", { tags: ["data:lorebook", "ui:right-panel"] }),
    ];
    expect(
      groupPlugins(items, (tag) => tag ?? "No tags").map(({ id, plugins }) => ({
        id,
        ids: plugins.map((item) => item.id),
      })),
    ).toEqual([
      { id: "tag:cost:function", ids: ["counter"] },
      { id: "tag:cost:llm", ids: ["talker"] },
      { id: "tag:data:lorebook", ids: ["panel"] },
    ]);
  });

  it("names derived tags in the player's words and keeps written ones", () => {
    const t = (key: string) => `<${key}>`;
    expect(pluginTagLabel("cost:llm", t)).toBe("<session.pluginTags.costLlm>");
    expect(pluginTagLabel("ui:manual-action", t)).toBe(
      "<session.pluginTags.uiManualAction>",
    );
    expect(pluginTagLabel("mode:dialogue", t)).toBe("mode:dialogue");
  });

  const labels = {
    locale: "zh-CN",
    requiredByWorld: "世界必需",
    requestedByWorld: "世界默认",
    packOptional: "组合包可选",
  };

  it("explains recommendations from the resolved policy and pack", () => {
    expect(recommendationReason(plugins[2]!, plan, dialoguePack, labels)).toBe(
      "对话模式",
    );
  });

  it("calls a plugin required only when it provides a contract the world requires", () => {
    // Added by the world, yet nothing depends on it: a default, not a need.
    expect(recommendationReason(plugins[0]!, plan, null, labels)).toBe(
      "世界默认",
    );
    const requiring = {
      ...plan,
      policy: { ...plan.policy, requires: ["chat-mode@1"] },
    };
    expect(recommendationReason(plugins[2]!, requiring, null, labels)).toBe(
      "世界必需",
    );
  });
});
