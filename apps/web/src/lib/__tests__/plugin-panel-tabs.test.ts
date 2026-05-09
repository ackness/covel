import { describe, expect, it } from "vitest";
import {
  aggregateSpecsIntoGroups,
  compactTabLabel,
  panelProviderLabel,
  planPluginPanelProviders,
  pluginShortLabel,
} from "../plugin-panel-tabs.js";

describe("plugin-panel tab helpers", () => {
  it("groups shared panel specs and sorts by group order", () => {
    const warnings: string[] = [];
    const groups = aggregateSpecsIntoGroups(
      [
        {
          pluginId: "image-a",
          specs: [
            {
              id: "gallery",
              label: { "zh-CN": "画廊", en: "Gallery" },
              shortLabel: { "zh-CN": "画" },
              icon: "image",
              group: "image-studio",
              groupLabel: { "zh-CN": "图像工作台", en: "Image Studio" },
              groupOrder: 30,
              view: { component: "ImageGallery" },
            },
          ],
        },
        {
          pluginId: "image-b",
          specs: [
            {
              id: "jobs",
              label: { "zh-CN": "任务", en: "Jobs" },
              icon: "list",
              group: "image-studio",
              groupLabel: { en: "Conflicting Label" },
              groupOrder: 10,
              view: { component: "ImageJobs" },
            },
          ],
        },
        {
          pluginId: "codex",
          specs: [
            {
              id: "codex",
              label: "Codex",
              groupOrder: 5,
              view: { component: "Text" },
            },
          ],
        },
      ],
      "zh-CN",
      { warn: (message) => warnings.push(message) },
    );

    expect(groups.map((group) => group.id)).toEqual([
      "codex::codex",
      "image-studio",
    ]);
    expect(groups[1]?.label).toBe("图像工作台");
    expect(groups[1]?.shortLabel).toBe("画");
    expect(groups[1]?.subPanels.map((panel) => panel.pluginId)).toEqual([
      "image-a",
      "image-b",
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("compacts English and Chinese tab labels", () => {
    expect(compactTabLabel("Image Studio")).toBe("IS");
    expect(compactTabLabel("NPC Graph Index")).toBe("NGI");
    expect(compactTabLabel("图像工作台")).toBe("图像");
    expect(compactTabLabel("Codex")).toBe("Code");
  });

  it("plans provider groups and active sub-panels", () => {
    const group = aggregateSpecsIntoGroups(
      [
        {
          pluginId: "a",
          specs: [
            {
              id: "gallery",
              label: "Gallery",
              group: "image",
              view: { component: "ImageGallery" },
            },
            {
              id: "jobs",
              label: "Jobs",
              group: "image",
              view: { component: "ImageJobs" },
            },
          ],
        },
        {
          pluginId: "b",
          specs: [
            {
              id: "gallery",
              label: "Gallery",
              group: "image",
              view: { component: "ImageGallery" },
            },
          ],
        },
      ],
      "en-US",
    )[0]!;

    const plan = planPluginPanelProviders(group, 1);

    expect(plan.multiProvider).toBe(true);
    expect(plan.activeProviderId).toBe("a");
    expect(plan.providers.map((provider) => provider.pluginId)).toEqual([
      "a",
      "b",
    ]);
    expect(plan.activeProviderSubs.map((item) => item.sub.id)).toEqual([
      "gallery",
      "jobs",
    ]);
  });

  it("resolves provider labels from chat sub-panel labels or plugin manifests", () => {
    expect(
      panelProviderLabel(
        "branch-reply",
        "chat-mode",
        [
          {
            id: "reply",
            pluginId: "branch-reply",
            label: "Branch Reply",
            shortLabel: "BR",
            icon: "message-square",
            spec: {},
          },
        ],
        [],
        "en-US",
      ),
    ).toBe("BR");

    const plugins = [
      { id: "image-a", displayName: { "zh-CN": "图像甲", en: "Image A" } },
    ];
    expect(pluginShortLabel("image-a", plugins, "zh-CN")).toBe("图像甲");
    expect(panelProviderLabel("missing", "image", [], plugins, "zh-CN")).toBe(
      "missing",
    );
  });
});
