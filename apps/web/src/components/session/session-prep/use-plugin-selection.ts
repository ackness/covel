import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DIMENSION_CONTRACT, resolveSessionPlugins } from "@covel/shared";
import {
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPlugins,
  groupPlugins,
} from "@/lib/session-plugin-selection.js";
import {
  isBuiltinDefaultPackage,
  requiredPluginIdsForWorld,
} from "./plugin-selection-helpers.js";
import * as api from "@/services/api.js";

export interface UsePluginSelectionResult {
  corePluginIds: ReadonlySet<string>;
  lockedPluginIds: ReadonlySet<string>;
  selectedPlugins: ReadonlySet<string>;
  selectedPluginSummaries: api.PluginSummary[];
  selectedPluginIds: string[];
  requestedPluginIds: string[];
  excludedPluginIds: string[];
  selectedPluginIdSet: ReadonlySet<string>;
  pluginPlan: api.WorldPluginPlan | null;
  pluginPlanLoading: boolean;
  pluginPlanError: string | null;
  /** World-requested plugins that are not installed on this host. */
  missingPluginIds: string[];
  /** Contracts the world requires that the current selection leaves unprovided. */
  unmetRequirements: readonly import("@covel/shared").UnmetWorldRequirement[];
  pluginPacks: readonly import("@covel/shared").PluginPack[];
  activePluginPack: import("@covel/shared").PluginPack | null;
  pluginSearch: string;
  activePluginTags: ReadonlySet<string>;
  availablePluginTags: string[];
  pluginGroups: ReturnType<typeof groupPlugins>;
  setPluginSearch: (value: string) => void;
  togglePluginTag: (tag: string) => void;
  applyPack: (packId: string) => void;
  /**
   * Back to the smallest set that still tells a story: the narrative plugins
   * (the selected ones, else the core ones), what they and the world need,
   * the provider of the world's dimensions, and nothing else. Every other core or world-requested plugin is excluded.
   */
  resetToMinimal: () => void;
  togglePlugin: (name: string) => void;
  retryPluginPlan: () => void;
}

// Stable identity while the plan is loading, so memoized resolutions hold.
const NO_CONTRACTS: readonly string[] = [];

export function usePluginSelection(
  worldId: string,
  plugins: api.PluginSummary[],
  prepareWorldForServer: () => Promise<void>,
): UsePluginSelectionResult {
  const { t } = useTranslation();
  const [pluginPlan, setPluginPlan] = useState<api.WorldPluginPlan | null>(
    null,
  );
  const [pluginPlanLoading, setPluginPlanLoading] = useState(true);
  const [pluginPlanError, setPluginPlanError] = useState<string | null>(null);
  const [pluginPlanRequest, setPluginPlanRequest] = useState(0);

  const retryPluginPlan = useCallback(() => {
    setPluginPlanRequest((request) => request + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPluginPlan(null);
    setPluginPlanError(null);
    setPluginPlanLoading(true);
    prepareWorldForServer()
      .then(() =>
        api.getWorldPluginPlan(worldId, {
          silentErrors: true,
        }),
      )
      .then((plan) => {
        if (cancelled) return;
        // Publish defaults with the plan so consumers never observe a ready
        // plan alongside the temporary core-only selection. A default the
        // initial pack also requests belongs to the pack, so the next pack can
        // replace it even when the world's preferred tags selected it too.
        const initialPack = plan.packs.find(
          (pack) => pack.id === plan.selectedPackId,
        );
        const packRequests = new Set(initialPack?.requested ?? []);
        setPackRequestedPlugins(packRequests);
        setOtherSelectedPlugins(
          new Set(
            [...defaultSelectedPluginIds(plan)].filter(
              (id) => !packRequests.has(id),
            ),
          ),
        );
        setExcludedPlugins(new Set(initialPack?.excluded ?? []));
        setPackExcludedPlugins(new Set(initialPack?.excluded ?? []));
        setActivePluginPackId(plan.selectedPackId ?? null);
        setPluginPlan(plan);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPluginPlanError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPluginPlanLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worldId, pluginPlanRequest, prepareWorldForServer]);

  const corePluginIds = useMemo(
    () =>
      new Set(
        plugins.filter(isBuiltinDefaultPackage).map((plugin) => plugin.id),
      ),
    [plugins],
  );
  const worldRequiredPluginIds = useMemo(
    () => requiredPluginIdsForWorld(pluginPlan),
    [pluginPlan],
  );
  const requiredContracts = pluginPlan?.policy.requires ?? NO_CONTRACTS;
  const [otherSelectedPlugins, setOtherSelectedPlugins] = useState<Set<string>>(
    () => new Set(corePluginIds),
  );
  // Pack ownership survives manual edits that clear the card's highlight.
  const [packRequestedPlugins, setPackRequestedPlugins] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedPlugins = useMemo(
    () => new Set([...otherSelectedPlugins, ...packRequestedPlugins]),
    [otherSelectedPlugins, packRequestedPlugins],
  );
  const [excludedPlugins, setExcludedPlugins] = useState<Set<string>>(
    () => new Set(),
  );
  // The exclusions the active pack added, so the next pack can lift them
  // without lifting the player's own.
  const [packExcludedPlugins, setPackExcludedPlugins] = useState<Set<string>>(
    () => new Set(),
  );
  const candidates = useMemo(
    () =>
      plugins.map((plugin) => ({
        ...plugin,
        authorized: plugin.source === "builtin",
      })),
    [plugins],
  );
  const resolution = useMemo(
    () =>
      resolveSessionPlugins({
        requested: [...selectedPlugins, ...worldRequiredPluginIds],
        excluded: [...excludedPlugins],
        plugins: candidates,
        requiredContracts,
      }),
    [
      candidates,
      selectedPlugins,
      excludedPlugins,
      worldRequiredPluginIds,
      requiredContracts,
    ],
  );
  // Approval-gated explicit requests stay selectable so creation can request consent.
  const selectedPluginIds = useMemo(
    () => [
      ...new Set([
        ...resolution.active,
        ...resolution.rejected
          .filter(
            (item) =>
              item.code === "approval-required" &&
              selectedPlugins.has(item.pluginId),
          )
          .map((item) => item.pluginId),
      ]),
    ],
    [resolution, selectedPlugins],
  );
  const selectedPluginIdSet = useMemo(
    () => new Set(selectedPluginIds),
    [selectedPluginIds],
  );
  const lockedPluginIds = useMemo(() => new Set<string>(), []);
  const selectedPluginSummaries = useMemo(
    () => plugins.filter((plugin) => selectedPluginIdSet.has(plugin.id)),
    [plugins, selectedPluginIdSet],
  );
  const pluginPacks = pluginPlan?.packs ?? [];
  const [activePluginPackId, setActivePluginPackId] = useState<string | null>(
    null,
  );
  const activePluginPack = useMemo(
    () => pluginPacks.find((pack) => pack.id === activePluginPackId) ?? null,
    [pluginPacks, activePluginPackId],
  );
  // Requests this host cannot satisfy. The world policy's always apply; a
  // pack's only while that pack is the active one.
  const missingPluginIds = useMemo(
    () => [
      ...new Set(
        (pluginPlan?.missing ?? [])
          .filter((item) => !item.packId || item.packId === activePluginPackId)
          .map((item) => item.pluginId),
      ),
    ],
    [pluginPlan, activePluginPackId],
  );
  const [pluginSearch, setPluginSearch] = useState("");
  const [activePluginTags, setActivePluginTags] = useState<Set<string>>(
    () => new Set(),
  );

  const availablePluginTags = useMemo(
    () => collectPluginTags(plugins),
    [plugins],
  );
  const visiblePlugins = useMemo(
    () => filterPlugins(plugins, pluginSearch, activePluginTags),
    [plugins, pluginSearch, activePluginTags],
  );
  const pluginGroups = useMemo(
    () =>
      groupPlugins(visiblePlugins, (groupId) =>
        t(`session.pluginGroups.${groupId}`, groupId),
      ),
    [visiblePlugins, t],
  );

  const togglePluginTag = useCallback((tag: string) => {
    setActivePluginTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const applyPack = useCallback(
    (packId: string) => {
      const pack = pluginPacks.find((item) => item.id === packId);
      if (!pack) return;
      setActivePluginPackId(pack.id);
      setPackRequestedPlugins(new Set(pack.requested));
      const excluded = new Set(excludedPlugins);
      for (const id of packExcludedPlugins) excluded.delete(id);
      const added = (pack.excluded ?? []).filter((id) => !excluded.has(id));
      for (const id of added) excluded.add(id);
      setExcludedPlugins(excluded);
      setPackExcludedPlugins(new Set(added));
    },
    [pluginPacks, excludedPlugins, packExcludedPlugins],
  );

  const resetToMinimal = useCallback(() => {
    const tellsStory = (plugin: api.PluginSummary) =>
      plugin.runtimes.some((runtime) => runtime.outputKind === "story");
    const selectedStory = plugins.filter(
      (plugin) => tellsStory(plugin) && selectedPluginIdSet.has(plugin.id),
    );
    const story = (
      selectedStory.length > 0
        ? selectedStory
        : plugins.filter(
            (plugin) => tellsStory(plugin) && plugin.kind === "core",
          )
    ).map((plugin) => plugin.id);
    // Resolve with no core default, so only what the narrative plugins and
    // the world's required contracts pull in stays. The dimension provider
    // stays too: a world that declares dimensions cannot start without it.
    const minimal = new Set(
      resolveSessionPlugins({
        requested: story,
        plugins: candidates.map((plugin) => ({ ...plugin, kind: "plugin" })),
        requiredContracts: [...requiredContracts, DIMENSION_CONTRACT],
      }).active,
    );
    setActivePluginPackId(null);
    setPackRequestedPlugins(new Set());
    setPackExcludedPlugins(new Set());
    setOtherSelectedPlugins(new Set(story));
    setExcludedPlugins(
      new Set(
        [
          ...plugins
            .filter((plugin) => plugin.kind === "core")
            .map((plugin) => plugin.id),
          ...worldRequiredPluginIds,
        ].filter((id) => !minimal.has(id)),
      ),
    );
  }, [
    plugins,
    candidates,
    selectedPluginIdSet,
    requiredContracts,
    worldRequiredPluginIds,
  ]);

  const togglePlugin = useCallback(
    (name: string) => {
      if (lockedPluginIds.has(name)) return;
      setActivePluginPackId(null);
      const enabling = !selectedPluginIdSet.has(name);
      const next = new Set(
        enabling ? [name, ...otherSelectedPlugins] : otherSelectedPlugins,
      );
      if (!enabling) next.delete(name);
      const excluded = new Set(excludedPlugins);
      if (enabling) {
        excluded.delete(name);
        const replacement = resolveSessionPlugins({
          requested: [
            ...next,
            ...packRequestedPlugins,
            ...worldRequiredPluginIds,
          ],
          excluded: [...excluded],
          plugins: candidates,
          requiredContracts,
        });
        // A successful explicit choice replaces only previously active conflicts.
        // Keep unresolved requests so missing dependencies still reach validation.
        if (replacement.active.includes(name)) {
          for (const rejected of replacement.rejected) {
            if (
              selectedPluginIdSet.has(rejected.pluginId) &&
              (rejected.code === "conflict" ||
                rejected.code === "single-provider-conflict" ||
                rejected.code === "event-topic-conflict")
            ) {
              next.delete(rejected.pluginId);
              excluded.add(rejected.pluginId);
            }
          }
        }
      } else excluded.add(name);
      setExcludedPlugins(excluded);
      setOtherSelectedPlugins(next);
    },
    [
      lockedPluginIds,
      otherSelectedPlugins,
      packRequestedPlugins,
      selectedPluginIdSet,
      excludedPlugins,
      candidates,
      worldRequiredPluginIds,
      requiredContracts,
    ],
  );

  return {
    corePluginIds,
    lockedPluginIds,
    selectedPlugins: selectedPluginIdSet,
    selectedPluginSummaries,
    selectedPluginIds,
    requestedPluginIds: [
      ...new Set([...selectedPlugins, ...worldRequiredPluginIds]),
    ].filter((id) => !excludedPlugins.has(id)),
    excludedPluginIds: [...excludedPlugins],
    selectedPluginIdSet,
    pluginPlan,
    pluginPlanLoading,
    pluginPlanError,
    missingPluginIds,
    unmetRequirements: resolution.unmet,
    pluginPacks,
    activePluginPack,
    pluginSearch,
    activePluginTags,
    availablePluginTags,
    pluginGroups,
    setPluginSearch,
    togglePluginTag,
    applyPack,
    resetToMinimal,
    togglePlugin,
    retryPluginPlan,
  };
}
