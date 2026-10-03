import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSessionPlugins,
  type PluginSummary,
  type WorldPluginPlan,
} from "@covel/shared";
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
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    id,
    displayName: id,
    description: "",
    kind: "plugin",
    source: "builtin",
    hostState: "loaded",
    runtimeCount: 0,
    tags: [],
    provides: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    ...overrides,
  };
}

const CORE_PLUGIN = plugin("core", {
  kind: "core",
  provides: [{ contract: "story@1", default: true }],
});
const ALTERNATIVE_PLUGIN = plugin("alternative", {
  provides: ["story@1"],
  requires: ["dependency@1"],
});
const DEPENDENCY_PLUGIN = plugin("dependency", { provides: ["dependency@1"] });
const PLUGINS = [CORE_PLUGIN, ALTERNATIVE_PLUGIN, DEPENDENCY_PLUGIN];
const prepareWorldForServer = async () => {};

const PLAN: WorldPluginPlan = {
  worldId: "world-1",
  packs: [],
  policy: {
    preferredTags: [],
    avoidedTags: [],
    requested: ["world-required"],
    recommended: [],
  },
  defaultPluginIds: ["core", "world-required"],
  missing: [],
};

function selectionPlan(defaultPluginIds: string[]): WorldPluginPlan {
  return {
    ...PLAN,
    policy: { ...PLAN.policy, requested: [] },
    defaultPluginIds,
  };
}

describe("usePluginSelection", () => {
  it("does not infer new-session authorization from a globally loaded community entry", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["community"]),
    );
    const community = plugin("community", {
      source: "community",
      hostState: "loaded",
      requires: ["dependency@1"],
    });
    const { result } = renderHook(() =>
      usePluginSelection(
        PLAN.worldId,
        [community, DEPENDENCY_PLUGIN],
        prepareWorldForServer,
      ),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.selectedPluginIds).toContain("community");
    expect(result.current.selectedPluginIds).not.toContain("dependency");
  });
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
      selectionPlan(["alternative"]),
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
    expect(result.current.requestedPluginIds).toEqual(["alternative"]);
    act(() => result.current.togglePlugin("alternative"));
    expect(result.current.selectedPluginIdSet.has("dependency")).toBe(false);
    expect(result.current.excludedPluginIds).toEqual(["alternative"]);
  });

  it("replaces a core plugin and adds dependencies when enabling its alternative", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["core"]),
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );

    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
    act(() => result.current.togglePlugin("alternative"));

    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
    expect(result.current.activePluginPack).toBeNull();

    act(() => result.current.togglePlugin("alternative"));
    expect(result.current.selectedPluginIdSet.has("alternative")).toBe(false);
    expect(result.current.selectedPluginIdSet.has("core")).toBe(true);
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
  });

  it("submits only the selected conflicting provider without promoting dependencies", async () => {
    const original = plugin("original", {
      provides: ["story@1"],
      conflicts: ["story@1"],
    });
    const replacement = plugin("replacement", {
      provides: ["story@1"],
      conflicts: ["story@1"],
      requires: ["dependency@1"],
    });
    const plugins = [original, replacement, DEPENDENCY_PLUGIN];
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["original"]),
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, plugins, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));

    act(() => result.current.togglePlugin("replacement"));

    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["replacement", "dependency"]),
    );
    expect(result.current.requestedPluginIds).toEqual(["replacement"]);
    expect(result.current.excludedPluginIds).toContain("original");
    const submitted = resolveSessionPlugins({
      requested: result.current.requestedPluginIds,
      excluded: result.current.excludedPluginIds,
      plugins: plugins.map((entry) => ({ ...entry, authorized: true })),
    });
    expect(submitted.active).toEqual(result.current.selectedPluginIds);
    expect(submitted.rejected).toEqual([]);
  });

  it("explicitly replaces a core single-point provider and keeps it disabled", async () => {
    const extension = { point: "history.compact@1", id: "summary" };
    const original = plugin("original", {
      kind: "core",
      extensions: [extension],
    });
    const replacement = plugin("replacement", { extensions: [extension] });
    const plugins = [original, replacement];
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(
      selectionPlan(["original"]),
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, plugins, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));

    act(() => result.current.togglePlugin("replacement"));

    expect(result.current.selectedPluginIds).toEqual(["replacement"]);
    expect(result.current.requestedPluginIds).toEqual(["replacement"]);
    expect(result.current.excludedPluginIds).toContain("original");
    act(() => result.current.togglePlugin("replacement"));
    expect(result.current.selectedPluginIds).toEqual([]);
    act(() => result.current.togglePlugin("original"));
    expect(result.current.selectedPluginIds).toEqual(["original"]);
    expect(result.current.excludedPluginIds).not.toContain("original");
  });

  it("does not silently remove an explicit request with a missing dependency", async () => {
    const broken = plugin("broken", { requires: ["missing@1"] });
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue(selectionPlan([]));
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, [broken], prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.togglePlugin("broken"));
    expect(result.current.requestedPluginIds).toEqual(["broken"]);
    expect(result.current.excludedPluginIds).toEqual([]);
    const submitted = resolveSessionPlugins({
      requested: result.current.requestedPluginIds,
      plugins: [{ ...broken, authorized: true }],
    });
    expect(submitted.rejected).toContainEqual(
      expect.objectContaining({ pluginId: "broken", code: "missing-provider" }),
    );
  });

  it("reports missing world plugins for the policy and for the active pack only", async () => {
    const pack = {
      id: "tabletop",
      label: "Tabletop",
      requested: ["core"],
      recommended: [],
      tags: [],
      source: "world" as const,
    };
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan(["core"]),
      packs: [pack],
      missing: [
        { pluginId: "world-dice" },
        { pluginId: "pack-map", packId: pack.id },
        { pluginId: "world-dice", packId: pack.id },
        { pluginId: "other-pack-only", packId: "other" },
      ],
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.missingPluginIds).toEqual(["world-dice"]);

    act(() => result.current.applyPack(pack.id));
    expect(result.current.missingPluginIds).toEqual(["world-dice", "pack-map"]);
  });

  it("keeps an explicitly excluded core disabled after applying a pack", async () => {
    const pack = {
      id: "core-pack",
      label: "Core",
      requested: ["core"],
      recommended: [],
      tags: [],
      source: "world" as const,
    };
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan([]),
      packs: [pack],
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.togglePlugin("core"));
    act(() => result.current.applyPack(pack.id));
    expect(result.current.selectedPluginIdSet.has("core")).toBe(false);
    expect(result.current.excludedPluginIds).toEqual(["core"]);
  });

  it("applies a replacement pack even when it excludes the currently locked core", async () => {
    const pack = {
      id: "alternative-pack",
      label: "Alternative pack",
      requested: ["alternative"],
      recommended: [],
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
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
    act(() => result.current.applyPack(pack.id));

    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    expect(result.current.activePluginPack).toEqual(pack);
    expect(result.current.lockedPluginIds.has("core")).toBe(false);
  });
});
