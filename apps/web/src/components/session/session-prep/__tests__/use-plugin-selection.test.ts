import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSessionPlugins,
  type PluginSummary,
  type PluginPack,
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
    eventTopics: [],
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
    languages: { text: ["en"], instructions: ["en"] },
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
    requires: [],
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

const PACKS: PluginPack[] = [
  {
    id: "full",
    label: "Full",
    requested: ["core", "extra"],
    recommended: [],
    tags: [],
    source: "builtin",
  },
  {
    id: "alternative",
    label: "Alternative",
    requested: ["alternative"],
    recommended: [],
    tags: [],
    source: "builtin",
  },
  {
    id: "small",
    label: "Small",
    requested: ["core"],
    recommended: ["extra"],
    tags: [],
    source: "builtin",
  },
];
const PACK_PLUGINS = [
  ...PLUGINS,
  plugin("extra"),
  plugin("manual"),
  plugin("preferred"),
  plugin("world"),
];

describe("usePluginSelection", () => {
  it("replaces pack requests in both directions and removes optional extras for a smaller pack", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan([]),
      packs: PACKS,
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PACK_PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));

    act(() => result.current.applyPack("full"));
    act(() => result.current.applyPack("alternative"));
    expect(result.current.requestedPluginIds).toEqual(["alternative"]);
    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["alternative", "dependency"]),
    );
    act(() => result.current.applyPack("full"));
    expect(result.current.selectedPluginIdSet).toEqual(
      new Set(["core", "extra"]),
    );
    act(() => result.current.applyPack("small"));
    expect(result.current.requestedPluginIds).toEqual(["core"]);
    expect(result.current.selectedPluginIdSet.has("extra")).toBe(false);
    expect(result.current.activePluginPack?.id).toBe("small");
  });

  it("separates the initial pack from world defaults and preserves explicitly excluded world requests", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan(["alternative", "world", "preferred"]),
      policy: {
        ...PLAN.policy,
        requested: ["world"],
        preferredTags: ["preferred"],
      },
      packs: PACKS,
      selectedPackId: "alternative",
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PACK_PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.togglePlugin("world"));
    act(() => result.current.applyPack("small"));
    expect(new Set(result.current.requestedPluginIds)).toEqual(
      new Set(["core", "preferred"]),
    );
    expect(result.current.selectedPluginIdSet.has("alternative")).toBe(false);
    expect(result.current.excludedPluginIds).toEqual(["world"]);
  });

  it("lets the next pack replace an engine that the initial pack and the world's preferred tags both selected", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan(["alternative", "preferred"]),
      policy: {
        ...PLAN.policy,
        requested: [],
        preferredTags: ["mode:alternative"],
      },
      packs: PACKS,
      selectedPackId: "alternative",
    });
    const plugins = PACK_PLUGINS.map((pkg) =>
      pkg.id === "alternative" || pkg.id === "preferred"
        ? { ...pkg, tags: ["mode:alternative"] }
        : pkg,
    );
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, plugins, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.selectedPluginIdSet.has("alternative")).toBe(true);

    act(() => result.current.applyPack("small"));
    // The preferred default outside the pack stays; the pack's engine goes.
    expect(new Set(result.current.requestedPluginIds)).toEqual(
      new Set(["core", "preferred"]),
    );
    expect(result.current.selectedPluginIdSet.has("core")).toBe(true);
    expect(result.current.selectedPluginIdSet.has("alternative")).toBe(false);
    expect(result.current.activePluginPack?.id).toBe("small");
  });

  it("keeps an explicit exclusion when a later pack requests the plugin", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan([]),
      packs: PACKS,
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PACK_PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.applyPack("full"));
    act(() => result.current.togglePlugin("extra"));
    act(() => result.current.applyPack("small"));
    act(() => result.current.applyPack("full"));
    expect(result.current.selectedPluginIdSet.has("extra")).toBe(false);
    expect(result.current.excludedPluginIds).toContain("extra");
  });

  it("remembers pack ownership after manual edits and keeps a manually re-enabled pack member", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan([]),
      packs: PACKS,
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PACK_PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.applyPack("full"));
    act(() => result.current.togglePlugin("manual"));
    expect(result.current.activePluginPack).toBeNull();
    act(() => result.current.togglePlugin("extra"));
    act(() => result.current.togglePlugin("extra"));
    act(() => result.current.applyPack("alternative"));
    expect(new Set(result.current.requestedPluginIds)).toEqual(
      new Set(["manual", "extra", "alternative"]),
    );
    expect(result.current.requestedPluginIds).not.toContain("core");
    expect(result.current.selectedPluginIdSet.has("dependency")).toBe(true);
  });

  it("resets pack, manual and excluded sources with the next world's plan", async () => {
    vi.mocked(api.getWorldPluginPlan)
      .mockResolvedValueOnce({ ...selectionPlan([]), packs: PACKS })
      .mockResolvedValueOnce({
        ...selectionPlan(["alternative"]),
        worldId: "world-2",
        packs: PACKS,
        selectedPackId: "alternative",
      });
    const { result, rerender } = renderHook(
      ({ worldId }) =>
        usePluginSelection(worldId, PACK_PLUGINS, prepareWorldForServer),
      { initialProps: { worldId: PLAN.worldId } },
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    act(() => result.current.applyPack("full"));
    act(() => result.current.togglePlugin("manual"));
    act(() => result.current.togglePlugin("extra"));
    rerender({ worldId: "world-2" });
    await waitFor(() =>
      expect(result.current.pluginPlan?.worldId).toBe("world-2"),
    );
    expect(result.current.requestedPluginIds).toEqual(["alternative"]);
    expect(result.current.excludedPluginIds).toEqual([]);
    expect(result.current.activePluginPack?.id).toBe("alternative");
    act(() => result.current.applyPack("small"));
    expect(result.current.requestedPluginIds).toEqual(["core"]);
  });
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
    const extension = { point: "history.compact@2", id: "summary" };
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

  it("adds the provider of a world-required contract and reports turning it off", async () => {
    vi.mocked(api.getWorldPluginPlan).mockResolvedValue({
      ...selectionPlan(["core"]),
      policy: { ...PLAN.policy, requested: [], requires: ["dependency@1"] },
    });
    const { result } = renderHook(() =>
      usePluginSelection(PLAN.worldId, PLUGINS, prepareWorldForServer),
    );
    await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
    expect(result.current.selectedPluginIdSet.has("dependency")).toBe(true);
    // The world's provider is a dependency, not something the player requested.
    expect(result.current.requestedPluginIds).toEqual(["core"]);
    expect(result.current.unmetRequirements).toEqual([]);

    act(() => result.current.togglePlugin("dependency"));
    expect(result.current.selectedPluginIdSet.has("dependency")).toBe(false);
    expect(result.current.unmetRequirements).toEqual([
      {
        contract: "dependency@1",
        code: "excluded",
        candidates: ["dependency"],
      },
    ]);
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
