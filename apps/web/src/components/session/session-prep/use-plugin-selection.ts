import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIds,
  filterPluginPackages,
  groupPluginPackages,
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
  selectedPackages: api.PluginSummary[];
  selectedPluginIds: string[];
  selectedPluginIdSet: ReadonlySet<string>;
  pluginPlan: api.WorldPluginPlan | null;
  pluginPlanLoading: boolean;
  pluginPacks: readonly import("@covel/shared").PluginPack[];
  activePluginPack: import("@covel/shared").PluginPack | null;
  pluginSearch: string;
  activePluginTags: ReadonlySet<string>;
  availablePluginTags: string[];
  pluginGroups: ReturnType<typeof groupPluginPackages>;
  setPluginSearch: (value: string) => void;
  togglePluginTag: (tag: string) => void;
  applyPack: (packId: string) => void;
  togglePlugin: (name: string) => void;
}

export function usePluginSelection(
  worldId: string,
  packages: api.PluginSummary[],
): UsePluginSelectionResult {
  const { t } = useTranslation();
  const [pluginPlan, setPluginPlan] = useState<api.WorldPluginPlan | null>(
    null,
  );
  const [pluginPlanLoading, setPluginPlanLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPluginPlanLoading(true);
    api
      .getWorldPluginPlan(worldId)
      .then((plan) => {
        if (!cancelled) setPluginPlan(plan);
      })
      .catch(() => {
        if (!cancelled) setPluginPlan(null);
      })
      .finally(() => {
        if (!cancelled) setPluginPlanLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worldId]);

  const corePluginIds = useMemo(
    () => new Set(packages.filter(isLockedCorePackage).map((pkg) => pkg.id)),
    [packages],
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
  const selectedPackages = useMemo(
    () =>
      packages.filter(
        (pkg) => selectedPlugins.has(pkg.id) || lockedPluginIds.has(pkg.id),
      ),
    [packages, selectedPlugins, lockedPluginIds],
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
    () => collectPluginTags(packages),
    [packages],
  );
  const visiblePluginPackages = useMemo(
    () => filterPluginPackages(packages, pluginSearch, activePluginTags),
    [packages, pluginSearch, activePluginTags],
  );
  const pluginGroups = useMemo(
    () =>
      groupPluginPackages(visiblePluginPackages, (groupId) =>
        t(`session.pluginGroups.${groupId}`, groupId),
      ),
    [visiblePluginPackages, t],
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
        applyPluginPackSelection(prev, pack, packages, lockedPluginIds),
      );
    },
    [pluginPacks, packages, lockedPluginIds],
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
    selectedPackages,
    selectedPluginIds,
    selectedPluginIdSet,
    pluginPlan,
    pluginPlanLoading,
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
  };
}
