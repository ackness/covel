import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { Play, ArrowLeft } from "lucide-react";
import * as api from "@/services/api.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { text } from "@/components/world/editor-helpers.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useRuntimeBindings } from "@/hooks/use-runtime-bindings.js";
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
} from "./session-prep/plugin-selection-helpers.js";
import {
  isDeclaredSlotMissing,
  resolveDeclaredSlot,
} from "./session-prep/model-slot-helpers.js";
import {
  activeSessionRecords,
  removeSessionById,
  startPluginsPayload,
} from "./session-prep/session-actions.js";
import { WorldInfoCard } from "./session-prep/world-info-card.js";
import { SessionHistoryCard } from "./session-prep/session-history-card.js";
import { WorldLoreCard } from "./session-prep/world-lore-card.js";
import { DimensionActions } from "./session-prep/dimension-actions.js";
import { ModelsCard } from "./session-prep/models-card.js";
import { PluginSelectionCard } from "./session-prep/plugin-selection-card.js";
import type { SessionPrepScreenProps } from "./session-prep/types.js";
import { worldVisual } from "@/lib/world-visuals.js";

export { defaultSelectedPluginIdsForWorld, isLockedCorePackage };

export function SessionPrepScreen({
  world,
  packages,
  presets,
  llmConfig,
  onBack,
  onStart,
  onResume,
  onDeleteSession,
  settingsOpen,
  onSettingsOpenChange,
  settingsInitialKey,
}: SessionPrepScreenProps) {
  const { t } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    presets,
    llmConfig,
  );

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

  const [worldDataPreflight, setWorldDataPreflight] =
    useState<api.WorldDataPreflightResponse | null>(null);
  const [worldDataPreflightStatus, setWorldDataPreflightStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [worldDataPreflightError, setWorldDataPreflightError] = useState<
    string | null
  >(null);

  const runWorldDataPreflight = useCallback(async () => {
    setWorldDataPreflightStatus("loading");
    setWorldDataPreflightError(null);
    try {
      const result = await api.preflightWorldData(world.id, {
        plugins: selectedPluginIds,
      });
      setWorldDataPreflight(result);
      setWorldDataPreflightStatus("success");
    } catch (err) {
      setWorldDataPreflight(null);
      setWorldDataPreflightError(
        err instanceof Error ? err.message : String(err),
      );
      setWorldDataPreflightStatus("error");
    }
  }, [world.id, selectedPluginIds]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runWorldDataPreflight();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [runWorldDataPreflight]);

  const [prepBindings, setPrepBindingsState] = useState<Record<string, string>>(
    () => api.getPrepRuntimeBindings(world.id),
  );
  const bindingState = useRuntimeBindings(
    `prep:${world.id}`,
    selectedPackages,
    resolvedSlots,
    undefined,
    prepBindings,
    (next) => {
      setPrepBindingsState(next);
      api.setPrepRuntimeBindings(world.id, next);
    },
  );

  const [flowData, setFlowData] = useState<api.PluginFlowResponse | null>(null);
  useEffect(() => {
    api
      .fetchPluginFlows()
      .then(setFlowData)
      .catch(() => {});
  }, []);

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

  const [worldInfoExpanded, setWorldInfoExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [loreExpanded, setLoreExpanded] = useState(false);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [pluginSectionExpanded, setPluginSectionExpanded] = useState(true);
  const [existingSessions, setExistingSessions] = useState<api.SessionRecord[]>(
    [],
  );
  const [deleteTarget, setDeleteTarget] = useState<api.SessionRecord | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api
      .listSessions(world.id)
      .then(setExistingSessions)
      .catch(() => {});
  }, [world.id]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteSession(deleteTarget.id);
      setExistingSessions((prev) => removeSessionById(prev, deleteTarget.id));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDeleteSession]);

  const [loreValue, setLoreValue] = useState<string>(text(world.lore));
  const originalLore = text(world.lore);
  const isLoreModified = loreValue !== originalLore;

  useEffect(() => {
    api.getWorldOverlay(world.id).then((overlay) => {
      if (overlay?.lore) setLoreValue(overlay.lore);
    });
  }, [world.id]);

  const handleLoreChange = useCallback(
    (value: string) => {
      setLoreValue(value);
      if (value !== originalLore) {
        void api.setWorldOverlay(world.id, {
          lore: value,
          updatedAt: new Date().toISOString(),
        });
      } else {
        void api.removeWorldOverlay(world.id);
      }
    },
    [originalLore, world.id],
  );

  const resetLore = useCallback(() => {
    setLoreValue(originalLore);
    void api.removeWorldOverlay(world.id);
  }, [originalLore, world.id]);

  const handleSettingsOpenChange = useCallback(
    (open: boolean) => {
      onSettingsOpenChange(open);
      if (!open) refreshSlots();
    },
    [onSettingsOpenChange, refreshSlots],
  );

  const activeSessions = useMemo(
    () => activeSessionRecords(existingSessions),
    [existingSessions],
  );
  const visual = useMemo(() => worldVisual(world), [world]);
  const selectedFlowSteps = useMemo(() => {
    if (!flowData) return [];
    return flowData.steps.filter((step) =>
      selectedPluginIdSet.has(step.pluginId),
    );
  }, [flowData, selectedPluginIdSet]);

  const resolveSelectedDeclaredSlot = useCallback(
    (slotId: string) => resolveDeclaredSlot(resolvedSlots, slotId),
    [resolvedSlots],
  );
  const isSelectedDeclaredSlotMissing = useCallback(
    (slotId: string) => isDeclaredSlotMissing(resolvedSlots, slotId),
    [resolvedSlots],
  );

  const handleStart = useCallback(() => {
    onStart(startPluginsPayload(selectedPluginIds));
  }, [selectedPluginIds, onStart]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        initialKey={settingsInitialKey}
      />
      <ScrollArea className="w-full h-full">
        <div className="mx-auto max-w-5xl px-4 md:px-8 py-6 md:py-10">
          <header
            className="relative mb-7 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card"
            style={{ "--world-accent": visual.accent } as CSSProperties}
          >
            <img
              src={visual.image}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(90deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.58) 48%, rgba(0,0,0,.22) 100%)",
              }}
            />
            <div className="relative z-10 flex min-h-[260px] flex-col justify-between p-5 md:p-7 text-white">
              <div className="flex items-center justify-between gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 border border-white/12 bg-black/18 px-3 text-white/78 hover:bg-white/10 hover:text-white"
                  onClick={onBack}
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t("session.breadcrumbWorldSelect", "Select World")}
                </Button>
                <Button
                  size="sm"
                  className="h-9 shrink-0 px-5 font-bold uppercase tracking-widest"
                  style={{
                    background: "var(--world-accent)",
                    color: "black",
                  }}
                  onClick={handleStart}
                >
                  <Play className="w-4 h-4 mr-1.5" />
                  {t("session.startGame", "Start Game")}
                </Button>
              </div>

              <div className="max-w-2xl space-y-4">
                <SessionBreadcrumb
                  step="prep"
                  worldName={text(world.name)}
                  onGoWorldSelect={onBack}
                />
                <div>
                  <p className="ui-eyebrow mb-3 text-white/58">
                    {t("session.preparation", "Session Setup")}
                  </p>
                  <h1 className="ui-title text-4xl md:text-6xl leading-[.95] text-white">
                    {text(world.name)}
                  </h1>
                  <p className="mt-4 max-w-xl text-sm md:text-base leading-relaxed text-white/72">
                    {text(world.description)}
                  </p>
                </div>
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-3xl">
            <WorldInfoCard
              world={world}
              expanded={worldInfoExpanded}
              onToggle={() => setWorldInfoExpanded(!worldInfoExpanded)}
            />

            <SessionHistoryCard
              activeSessions={activeSessions}
              expanded={sessionsExpanded}
              onToggle={() => setSessionsExpanded(!sessionsExpanded)}
              onResume={onResume}
              onRequestDelete={setDeleteTarget}
            />

            <WorldLoreCard
              expanded={loreExpanded}
              onToggle={() => setLoreExpanded(!loreExpanded)}
              loreValue={loreValue}
              originalLore={originalLore}
              isModified={isLoreModified}
              onLoreChange={handleLoreChange}
              onResetLore={resetLore}
            />

            <DimensionActions
              worldId={world.id}
              enabled={Boolean(world.dimensions)}
            />

            <ModelsCard
              resolvedSlots={resolvedSlots}
              expanded={modelsExpanded}
              onToggle={() => setModelsExpanded(!modelsExpanded)}
              onOpenSettings={() => onSettingsOpenChange(true)}
            />

            <PluginSelectionCard
              world={world}
              packages={packages}
              selectedPluginIds={selectedPluginIds}
              selectedPluginIdSet={selectedPluginIdSet}
              selectedPackages={selectedPackages}
              expanded={pluginSectionExpanded}
              onToggleExpanded={() =>
                setPluginSectionExpanded(!pluginSectionExpanded)
              }
              pluginPacks={pluginPacks}
              activePluginPack={activePluginPack}
              activePluginTags={activePluginTags}
              availablePluginTags={availablePluginTags}
              pluginSearch={pluginSearch}
              onPluginSearchChange={setPluginSearch}
              onTogglePluginTag={togglePluginTag}
              onApplyPack={applyPack}
              pluginGroups={pluginGroups}
              corePluginIds={corePluginIds}
              lockedPluginIds={lockedPluginIds}
              bindingState={bindingState}
              resolvedSlots={resolvedSlots}
              resolveDeclaredSlot={resolveSelectedDeclaredSlot}
              isMissingDeclaredSlot={isSelectedDeclaredSlotMissing}
              onTogglePlugin={togglePlugin}
              worldDataPreflight={worldDataPreflight}
              worldDataPreflightStatus={worldDataPreflightStatus}
              worldDataPreflightError={worldDataPreflightError}
              onRetryWorldDataPreflight={runWorldDataPreflight}
              flowData={flowData}
              selectedFlowSteps={selectedFlowSteps}
            />
          </div>
        </div>
      </ScrollArea>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("session.deleteConfirmTitle", "Delete Session")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "session.deleteConfirmDesc",
                "This will permanently delete the session and all its data (messages, game state, etc.). This action cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <p className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1.5 break-all">
              {deleteTarget.id}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" disabled={deleting}>
                {t("common.cancel", "Cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting
                ? t("common.deleting", "Deleting...")
                : t("common.delete", "Delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
