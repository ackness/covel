import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPlugins,
  groupPlugins,
} from "@/lib/session-plugin-selection.js";
import {
  excludedPluginIdsForWorld,
  isLockedCorePackage,
  requiredPluginIdsForWorld,
} from "./plugin-selection-helpers.js";
import * as api from "@/services/api.js";

export interface UsePluginSelectionResult {
  corePluginIds: ReadonlySet<string>;
  lockedPluginIds: ReadonlySet<string>;
  selectedPlugins: ReadonlySet<string>;
  selectedPluginSummaries: api.PluginSummary[];
  selectedPluginIds: string[];
  selectedPluginIdSet: ReadonlySet<string>;
  pluginPlan: api.WorldPluginPlan | null;
  pluginPlanLoading: boolean;
  pluginPlanError: string | null;
  pluginPacks: readonly import("@covel/shared").PluginPack[];
  activePluginPack: import("@covel/shared").PluginPack | null;
  pluginSearch: string;
  activePluginTags: ReadonlySet<string>;
  availablePluginTags: string[];
  pluginGroups: ReturnType<typeof groupPlugins>;
  setPluginSearch: (value: string) => void;
  togglePluginTag: (tag: string) => void;
  applyPack: (packId: string) => void;
  togglePlugin: (name: string) => void;
  retryPluginPlan: () => void;
}

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
        if (!cancelled) setPluginPlan(plan);
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
      new Set(plugins.filter(isLockedCorePackage).map((plugin) => plugin.id)),
    [plugins],
  );
  const worldRequiredPluginIds = useMemo(
    () => requiredPluginIdsForWorld(pluginPlan),
    [pluginPlan],
  );
  const worldExcludedPluginIds = useMemo(
    () => excludedPluginIdsForWorld(pluginPlan),
    [pluginPlan],
  );
  const lockedPluginIds = useMemo(
    () => new Set([...corePluginIds, ...worldRequiredPluginIds]),
    [corePluginIds, worldRequiredPluginIds],
  );

  const [selectedPlugins, setSelectedPlugins] = useState<Set<string>>(
    () => new Set(corePluginIds),
  );
  const selectedPluginSummaries = useMemo(
    () =>
      plugins.filter(
        (plugin) =>
          selectedPlugins.has(plugin.id) || lockedPluginIds.has(plugin.id),
      ),
    [plugins, selectedPlugins, lockedPluginIds],
  );
  const selectedPluginIds = useMemo(
    () => [...new Set([...selectedPlugins, ...lockedPluginIds])],
    [selectedPlugins, lockedPluginIds],
  );
  const selectedPluginIdSet = useMemo(
    () => new Set(selectedPluginIds),
    [selectedPluginIds],
  );
  const pluginPacks = pluginPlan?.packs ?? [];
  const [activePluginPackId, setActivePluginPackId] = useState<string | null>(
    null,
  );
  const activePluginPack = useMemo(
    () => pluginPacks.find((pack) => pack.id === activePluginPackId) ?? null,
    [pluginPacks, activePluginPackId],
  );
  const [pluginSearch, setPluginSearch] = useState("");
  const [activePluginTags, setActivePluginTags] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!pluginPlan) return;
    setSelectedPlugins(defaultSelectedPluginIds(pluginPlan));
    setActivePluginPackId(pluginPlan.selectedPackId ?? null);
  }, [pluginPlan]);
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

  // Sync locked/excluded plugin lists whenever they change
  useEffect(() => {
    setSelectedPlugins((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of worldExcludedPluginIds) {
        if (!lockedPluginIds.has(id) && next.delete(id)) changed = true;
      }
      for (const id of lockedPluginIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [lockedPluginIds, worldExcludedPluginIds]);

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
      setSelectedPlugins((prev) =>
        applyPluginPackSelection(prev, pack, plugins, lockedPluginIds),
      );
    },
    [pluginPacks, plugins, lockedPluginIds],
  );

  const togglePlugin = useCallback(
    (name: string) => {
      if (lockedPluginIds.has(name)) return;
      setActivePluginPackId(null);
      setSelectedPlugins((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    },
    [lockedPluginIds],
  );

  return {
    corePluginIds,
    lockedPluginIds,
    selectedPlugins,
    selectedPluginSummaries,
    selectedPluginIds,
    selectedPluginIdSet,
    pluginPlan,
    pluginPlanLoading,
    pluginPlanError,
    pluginPacks,
    activePluginPack,
    pluginSearch,
    activePluginTags,
    availablePluginTags,
    pluginGroups,
    setPluginSearch,
    togglePluginTag,
    applyPack,
    togglePlugin,
    retryPluginPlan,
  };
}
