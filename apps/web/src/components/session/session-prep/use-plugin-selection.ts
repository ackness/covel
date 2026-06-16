import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  applyPluginPackSelection,
  collectPluginTags,
  filterPluginPackages,
  groupPluginPackages,
  pluginPacksForWorld,
  selectedPackForWorld,
} from "@/lib/session-plugin-selection.js";
import {
  defaultSelectedPluginIdsForWorld,
  excludedPluginIdsForWorld,
  isLockedCorePackage,
  requiredPluginIdsForWorld,
} from "./plugin-selection-helpers.js";
import type * as api from "@/services/api.js";

export interface UsePluginSelectionResult {
  corePluginIds: ReadonlySet<string>;
  lockedPluginIds: ReadonlySet<string>;
  selectedPlugins: ReadonlySet<string>;
  selectedPackages: api.PackageSummary[];
  selectedPluginIds: string[];
  selectedPluginIdSet: ReadonlySet<string>;
  pluginPacks: ReturnType<typeof pluginPacksForWorld>;
  activePluginPack: ReturnType<typeof pluginPacksForWorld>[number] | null;
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
  world: api.WorldRecord,
  packages: api.PackageSummary[],
): UsePluginSelectionResult {
  const { t } = useTranslation();

  const corePluginIds = useMemo(
    () => new Set(packages.filter(isLockedCorePackage).map((pkg) => pkg.name)),
    [packages],
  );
  const worldRequiredPluginIds = useMemo(
    () => requiredPluginIdsForWorld(world),
    [world],
  );
  const worldExcludedPluginIds = useMemo(
    () => excludedPluginIdsForWorld(world),
    [world],
  );
  const lockedPluginIds = useMemo(
    () =>
      new Set([
        ...[...corePluginIds].filter(
          (pluginId) => !worldExcludedPluginIds.has(pluginId),
        ),
        ...worldRequiredPluginIds,
      ]),
    [corePluginIds, worldRequiredPluginIds, worldExcludedPluginIds],
  );

  const [selectedPlugins, setSelectedPlugins] = useState<Set<string>>(() =>
    defaultSelectedPluginIdsForWorld(world, packages),
  );
  const selectedPackages = useMemo(
    () =>
      packages.filter(
        (pkg) => selectedPlugins.has(pkg.name) || lockedPluginIds.has(pkg.name),
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
  const pluginPacks = useMemo(() => pluginPacksForWorld(world), [world]);
  const worldDefaultPack = useMemo(() => selectedPackForWorld(world), [world]);
  const [activePluginPackId, setActivePluginPackId] = useState<string | null>(
    () => worldDefaultPack?.id ?? null,
  );
  const activePluginPack = useMemo(
    () => pluginPacks.find((pack) => pack.id === activePluginPackId) ?? null,
    [pluginPacks, activePluginPackId],
  );
  const [pluginSearch, setPluginSearch] = useState("");
  const [activePluginTags, setActivePluginTags] = useState<Set<string>>(
    () => new Set(),
  );
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
