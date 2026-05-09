import { describe, expect, it } from "vitest";
import type { PackageSummary, WorldRecord } from "@/services/api.js";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIdsForWorld,
  filterPluginPackages,
  groupPluginPackages,
  pluginPacksForWorld,
  recommendationReason,
  selectedPackForWorld,
} from "../session-plugin-selection.js";

function world(metadata: WorldRecord["metadata"]): WorldRecord {
  return {
    id: "world",
    name: "World",
    description: "World",
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const packages: PackageSummary[] = [
  {
    name: "pregame",
    pluginType: "core-plugin",
    source: "builtin",
    enabled: true,
    tags: ["role:pre-game", "cost:function"],
  },
  {
    name: "narrator",
    pluginType: "core-plugin",
    source: "builtin",
    enabled: true,
    tags: ["mode:traditional-story", "role:narrator", "cost:llm"],
    capabilities: ["narrative"],
  },
  {
    name: "chat-mode-narrator",
    pluginType: "plugin",
    source: "builtin",
    enabled: true,
    tags: ["mode:dialogue", "role:narrator", "cost:llm"],
    capabilities: ["narrative", "chat-mode"],
  },
  {
    name: "scene-cast",
    pluginType: "plugin",
    source: "builtin",
    enabled: true,
    tags: ["mode:dialogue", "role:scene-state", "cost:function"],
  },
  {
    name: "codex",
    pluginType: "plugin",
    source: "builtin",
    enabled: true,
    tags: ["role:codex", "data:lorebook", "cost:llm"],
  },
];

describe("session plugin selection helpers", () => {
  it("uses pluginPolicy preset plus legacy exclusions for defaults", () => {
    const selected = defaultSelectedPluginIdsForWorld(
      world({
        requiredPlugins: ["pregame"],
        excludedPlugins: ["narrator"],
        pluginPolicy: {
          preset: "dialogue-mode",
          preferTags: ["mode:dialogue"],
        },
      }),
      packages,
      (pkg) => pkg.pluginType === "core-plugin" && pkg.source === "builtin",
    );

    expect(selected.has("pregame")).toBe(true);
    expect(selected.has("chat-mode-narrator")).toBe(true);
    expect(selected.has("scene-cast")).toBe(true);
    expect(selected.has("narrator")).toBe(false);
  });

  it("merges world-defined packs before builtin packs", () => {
    const customWorld = world({
      pluginPolicy: {
        preset: "custom",
        packs: [
          {
            id: "custom",
            label: "Custom",
            plugins: ["pregame", "codex"],
            tags: ["role:codex"],
          },
        ],
      },
    });
    const packs = pluginPacksForWorld(customWorld);

    expect(packs[0]?.id).toBe("custom");
    expect(selectedPackForWorld(customWorld)?.id).toBe("custom");
  });

  it("applies packs without removing locked plugins", () => {
    const pack = pluginPacksForWorld(world({})).find(
      (item) => item.id === "dialogue-mode",
    );
    expect(pack).toBeTruthy();

    const selected = applyPluginPackSelection(
      new Set(["narrator"]),
      pack!,
      packages,
      new Set(["narrator"]),
    );

    expect(selected.has("narrator")).toBe(true);
    expect(selected.has("chat-mode-narrator")).toBe(true);
  });

  it("keeps player persona optional outside dialogue mode", () => {
    const traditional = pluginPacksForWorld(world({})).find(
      (item) => item.id === "traditional-story",
    );
    const lowCost = pluginPacksForWorld(world({})).find(
      (item) => item.id === "low-cost",
    );
    const dialogue = pluginPacksForWorld(world({})).find(
      (item) => item.id === "dialogue-mode",
    );

    expect(traditional?.plugins).not.toContain("player-identity");
    expect(traditional?.optionalPlugins).toContain("player-identity");
    expect(traditional?.plugins).toContain("living-world-rules");
    expect(lowCost?.plugins).not.toContain("player-identity");
    expect(lowCost?.optionalPlugins).toContain("player-identity");
    expect(dialogue?.plugins).toContain("player-identity");
  });

  it("filters and groups packages by tags", () => {
    expect(collectPluginTags(packages)).toContain("mode:dialogue");

    const filtered = filterPluginPackages(
      packages,
      "chat",
      new Set(["mode:dialogue"]),
    );
    expect(filtered.map((pkg) => pkg.name)).toEqual(["chat-mode-narrator"]);

    const groups = groupPluginPackages(packages, (group) => group);
    expect(groups.map((group) => group.id)).toContain("dialogue");
  });

  it("explains selected world recommendations", () => {
    const w = world({
      pluginPolicy: {
        preset: "dialogue-mode",
        preferTags: ["mode:dialogue"],
      },
    });
    const reason = recommendationReason(
      packages[2],
      w,
      selectedPackForWorld(w),
      {
        locale: "zh-CN",
        requiredByWorld: "世界必需",
        packOptional: "组合包可选",
        recommendedByWorld: "世界推荐",
      },
    );

    expect(reason).toBe("Dialogue Mode");
  });
});
