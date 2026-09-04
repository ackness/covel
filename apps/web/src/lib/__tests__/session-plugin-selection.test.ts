import { describe, expect, it } from "vitest";
import type { PluginPack, PluginSummary, WorldPluginPlan } from "@covel/shared";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPluginPackages,
  groupPluginPackages,
  recommendationReason,
} from "../session-plugin-selection.js";

function plugin(
  id: string,
  options: Partial<PluginSummary> = {},
): PluginSummary {
  return {
    id,
    displayName: id,
    description: `${id} plugin`,
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 0,
    capabilities: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    ...options,
  };
}

const plugins = [
  plugin("pregame", { pluginType: "core-plugin", tags: ["role:pre-game"] }),
  plugin("narrator", {
    pluginType: "core-plugin",
    tags: ["mode:traditional-story", "role:narrator"],
    capabilities: ["narrative"],
  }),
  plugin("chat-mode-narrator", {
    tags: ["mode:dialogue", "role:narrator"],
    capabilities: ["narrative", "chat-mode"],
  }),
  plugin("scene-cast", { tags: ["mode:dialogue"] }),
];

const dialoguePack: PluginPack = {
  id: "dialogue-mode",
  label: { "en-US": "Dialogue Mode", "zh-CN": "对话模式" },
  pluginIds: ["chat-mode-narrator", "scene-cast"],
  optionalPluginIds: [],
  excludedPluginIds: ["narrator"],
  tags: ["mode:dialogue"],
  source: "builtin",
};

const plan: WorldPluginPlan = {
  worldId: "world",
  packs: [dialoguePack],
  selectedPackId: dialoguePack.id,
  policy: {
    preferredTags: ["mode:dialogue"],
    avoidedTags: [],
    requiredCapabilities: [],
    requiredPluginIds: ["pregame"],
    recommendedPluginIds: ["chat-mode-narrator"],
    excludedPluginIds: ["narrator"],
  },
  defaultPluginIds: ["pregame", "chat-mode-narrator", "scene-cast"],
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
      filterPluginPackages(plugins, "chat", new Set(["mode:dialogue"])).map(
        (item) => item.id,
      ),
    ).toEqual(["chat-mode-narrator"]);
    expect(
      groupPluginPackages(plugins, (group) => group).map((group) => group.id),
    ).toContain("dialogue");
  });

  it("explains recommendations from the resolved policy and pack", () => {
    expect(
      recommendationReason(plugins[2]!, plan, dialoguePack, {
        locale: "zh-CN",
        requiredByWorld: "世界必需",
        packOptional: "组合包可选",
        recommendedByWorld: "世界推荐",
      }),
    ).toBe("对话模式");
  });
});
