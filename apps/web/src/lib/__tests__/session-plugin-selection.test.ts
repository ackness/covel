// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PluginPack, PluginSummary, WorldPluginPlan } from "@covel/shared";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPlugins,
  groupPlugins,
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
    preferredTags: ["mode:dialogue"],
    avoidedTags: [],
    requested: ["pregame"],
    recommended: ["chat-mode-narrator"],
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
      groupPlugins(plugins, (group) => group).map((group) => group.id),
    ).toContain("dialogue");
  });

  const labels = {
    locale: "zh-CN",
    requiredByWorld: "世界必需",
    requestedByWorld: "世界默认",
    packOptional: "组合包可选",
    recommendedByWorld: "世界推荐",
  };

  it("explains recommendations from the resolved policy and pack", () => {
    expect(recommendationReason(plugins[2]!, plan, dialoguePack, labels)).toBe(
      "对话模式",
    );
  });

  it("calls a plugin required only when it provides a contract the world requires", () => {
    // Requested by the world, yet nothing depends on it: a default, not a need.
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
