import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary, WorldPluginPlan } from "@covel/shared";
import { usePluginSelection } from "../use-plugin-selection.js";
import * as api from "@/services/api.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/services/api.js", () => ({
  getWorldPluginPlan: vi.fn(),
}));

function plugin(
  id: string,
  overrides: Partial<PluginSummary> = {},
): PluginSummary {
  return {
    id,
    displayName: id,
    description: "",
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 0,
    tags: [],
    capabilities: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    ...overrides,
  };
}

const CORE_PLUGIN = plugin("core", {
  pluginType: "core-plugin",
  relations: { provides: ["story"] },
});
const ALTERNATIVE_PLUGIN = plugin("alternative", {
  relations: {
    provides: ["story"],
    conflicts: ["core"],
    requires: ["dependency/runtime"],
  },
});
const DEPENDENCY_PLUGIN = plugin("dependency");
const PLUGINS = [CORE_PLUGIN, ALTERNATIVE_PLUGIN, DEPENDENCY_PLUGIN];
const prepareWorldForServer = async () => {};

const PLAN: WorldPluginPlan = {
  worldId: "world-1",
  packs: [],
  policy: {
    preferredTags: [],
    avoidedTags: [],
    requiredCapabilities: [],
    requiredPluginIds: ["world-required"],
    recommendedPluginIds: [],
    excludedPluginIds: [],
  },
  defaultPluginIds: ["core", "world-required"],
};

function selectionPlan(defaultPluginIds: string[]): WorldPluginPlan {
  return {
    ...PLAN,
    policy: { ...PLAN.policy, requiredPluginIds: [] },
    defaultPluginIds,
  };
}

describe("usePluginSelection", () => {
  beforeEach(() => {
    vi.mocked(api.getWorldPluginPlan).mockReset();
  });

  it("keeps a failed plugin plan explicit and retries it", async () => {
    vi.mocked(api.getWorldPluginPlan)
      .mockRejectedValueOnce(new Error("plan unavailable"))
      .mockResolvedValueOnce(PLAN);

    const prepareWorldForServer = vi.fn(async () => {});
    const { result } = renderHook(() =>
      usePluginSelection("world-1", [CORE_PLUGIN], prepareWorldForServer),
    );

    await waitFor(() => {
      expect(result.current.pluginPlanLoading).toBe(false);
      expect(result.current.pluginPlanError).toBe("plan unavailable");
    });
    expect(result.current.pluginPlan).toBeNull();

    act(() => result.current.retryPluginPlan());

    await waitFor(() => {
      expect(result.current.pluginPlan).toEqual(PLAN);
      expect(result.current.pluginPlanError).toBeNull();
      expect(result.current.pluginPlanLoading).toBe(false);
    });
    expect(api.getWorldPluginPlan).toHaveBeenCalledTimes(2);
    expect(api.getWorldPluginPlan).toHaveBeenCalledWith("world-1", {
      silentErrors: true,
    });
    expect(prepareWorldForServer).toHaveBeenCalledTimes(2);
  });

  it("does not restore a core plugin replaced by the resolved initial plan", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["alternative", "dependency"]),
    );
    const readySelections: string[][] = [];
    const { result } = renderHook(() => {
      const selection = usePluginSelection(
        PLAN.worldId,
        PLUGINS,
        prepareWorldForServer,
      );
      if (!selection.pluginPlanLoading && selection.pluginPlan) {
        readySelections.push(selection.selectedPluginIds);
      }
      return selection;
    });

    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(readySelections.length).toBeGreaterThan(0);
    expect(readySelections.every((ids) => !ids.includes("core"))).toBe(true);
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
    expect(result.current.selectedPluginSummaries.map(({ id }) => id)).toEqual([
      "alternative",
      "dependency",
    ]);
  });

  it("includes required dependencies in the initial selected summaries", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["alternative"]),
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );

    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(result.current.selectedPluginSummaries).toContain(DEPENDENCY_PLUGIN);
  });

  it("replaces a core plugin and adds dependencies when enabling its alternative", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["core"]),
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );

    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.lockedPluginIds.has("core")).toBe(true);
    act(() => result.current.togglePlugin("alternative"));

    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
    expect(result.current.activePluginPack).toBeNull();

    act(() => result.current.togglePlugin("alternative"));
    expect(result.current.selectedPluginIdSet.has("alternative")).toBe(false);
    expect(result.current.selectedPluginIdSet.has("core")).toBe(true);
    expect(result.current.lockedPluginIds.has("core")).toBe(true);
  });

  it("applies a replacement pack even when it excludes the currently locked core", async () => {
    const pack = {
      id: "alternative-pack",
      label: "Alternative pack",
      pluginIds: ["alternative"],
      optionalPluginIds: [],
      excludedPluginIds: ["core"],
      tags: [],
      source: "world" as const,
    };
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan(["core"]),
      packs: [pack],
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );

    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.lockedPluginIds.has("core")).toBe(true);
    act(() => result.current.applyPack(pack.id));

    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(result.current.activePluginPack).toEqual(pack);
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
  });
});
