import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  MapIcon,
  Play,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FileText,
  Cpu,
  KeyRound,
  History,
  Trash2,
  Download,
  Upload,
  Puzzle,
  Lock,
  Zap,
  Wrench,
  Database,
  AlertTriangle,
  Loader2,
  Search,
} from "lucide-react";
import * as api from "@/services/api.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
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
import { ActiveModelSlots } from "./active-model-slots.js";
import { useSlotConfig, formatSlotLabel } from "@/hooks/use-slot-config.js";
import { useRuntimeBindings } from "@/hooks/use-runtime-bindings.js";
import {
  applyPluginPackSelection,
  collectPluginTags,
  defaultSelectedPluginIdsForWorld as computeDefaultSelectedPluginIdsForWorld,
  filterPluginPackages,
  groupPluginPackages,
  pluginPacksForWorld,
  readWorldPluginPolicy,
  recommendationReason,
  selectedPackForWorld,
  textValue,
} from "@/lib/session-plugin-selection.js";

interface SessionPrepScreenProps {
  world: api.WorldRecord;
  packages: api.PackageSummary[];
  presets: api.PresetSummary[];
  llmConfig?: api.LlmConfigResponse | null;
  onBack: () => void;
  onStart: (plugins?: string[]) => void;
  onResume: (session: api.SessionRecord) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  settingsInitialKey?: string;
}

export function isLockedCorePackage(
  pkg: Pick<api.PackageSummary, "pluginType" | "source">,
): boolean {
  return (
    pkg.pluginType === "core-plugin" &&
    (pkg.source === undefined || pkg.source === "builtin")
  );
}

export function defaultSelectedPluginIdsForWorld(
  world: api.WorldRecord,
  packages: readonly api.PackageSummary[],
): Set<string> {
  return computeDefaultSelectedPluginIdsForWorld(
    world,
    packages,
    isLockedCorePackage,
  );
}

function requiredPluginIdsForWorld(world: api.WorldRecord): Set<string> {
  return new Set(readWorldPluginPolicy(world).requiredPlugins);
}

function excludedPluginIdsForWorld(world: api.WorldRecord): Set<string> {
  return new Set(readWorldPluginPolicy(world).excludedPlugins);
}

// Reusable collapsible card header
function CollapsibleCardHeader({
  expanded,
  onToggle,
  children,
  summary,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  summary?: React.ReactNode;
}) {
  return (
    <CardHeader className="pb-2">
      <button
        className="w-full flex items-center justify-between text-left"
        onClick={onToggle}
      >
        <CardTitle className="flex items-center gap-2 text-base">
          {children}
        </CardTitle>
        {expanded ? (
          <ChevronUp className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 shrink-0" />
        )}
      </button>
      {!expanded && summary && (
        <p className="text-xs text-muted-foreground mt-1.5">{summary}</p>
      )}
    </CardHeader>
  );
}

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
  const { t, i18n } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    presets,
    llmConfig,
  );

  // Determine core plugins that cannot be deselected
  const corePluginIds = useMemo(
    () => new Set(packages.filter(isLockedCorePackage).map((p) => p.name)),
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

  // Plugin selection state — world metadata can provide a playstyle preset.
  const [selectedPlugins, setSelectedPlugins] = useState<Set<string>>(() =>
    defaultSelectedPluginIdsForWorld(world, packages),
  );
  const selectedPackages = useMemo(
    () =>
      packages.filter(
        (p) => selectedPlugins.has(p.name) || lockedPluginIds.has(p.name),
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
  // Prep bindings live in the SettingsStore under llm.prepRuntimeBindings
  // keyed by worldId. The hook keeps them in sync via `onPersist`.
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

  // Plugin flow data for execution preview
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

  // Section expand state — all collapsed by default except plugins
  const [worldInfoExpanded, setWorldInfoExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [loreExpanded, setLoreExpanded] = useState(false);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [pluginSectionExpanded, setPluginSectionExpanded] = useState(true);

  const [priorityOverrides, setPriorityOverrides] = useState<
    Record<string, number>
  >(() => api.getRuntimePriorityOverrides());
  const [expandedPlugins, setExpandedPluginsList] = useState<Set<string>>(
    new Set(),
  );
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
      setExistingSessions((prev) =>
        prev.filter((s) => s.id !== deleteTarget.id),
      );
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

  const handleLoreChange = (value: string) => {
    setLoreValue(value);
    if (value !== originalLore) {
      void api.setWorldOverlay(world.id, {
        lore: value,
        updatedAt: new Date().toISOString(),
      });
    } else {
      void api.removeWorldOverlay(world.id);
    }
  };

  const resetLore = () => {
    setLoreValue(originalLore);
    void api.removeWorldOverlay(world.id);
  };

  const togglePluginExpand = (name: string) => {
    setExpandedPluginsList((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handlePriorityChange = (qualifiedId: string, value: string) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0 || num > 1000) return;
    const updated = { ...priorityOverrides, [qualifiedId]: num };
    setPriorityOverrides(updated);
    api.setRuntimePriorityOverrides(updated);
  };

  const resetPriority = (qualifiedId: string) => {
    const updated = { ...priorityOverrides };
    delete updated[qualifiedId];
    setPriorityOverrides(updated);
    api.setRuntimePriorityOverrides(updated);
  };

  const handleSettingsOpenChange = (v: boolean) => {
    onSettingsOpenChange(v);
    if (!v) refreshSlots();
  };

  const activeSessions = existingSessions.filter((s) => s.status !== "ended");
  const totalRuntimes = selectedPackages.reduce(
    (sum, p) => sum + (p.runtimes?.length ?? 0),
    0,
  );

  // Build flow steps filtered by selected plugins
  const selectedFlowSteps = useMemo(() => {
    if (!flowData) return [];
    return flowData.steps.filter((s) => selectedPluginIdSet.has(s.pluginId));
  }, [flowData, selectedPluginIdSet]);

  const resolveDeclaredSlot = useCallback(
    (slotId: string) => {
      if (slotId === "default") return resolvedSlots[0] ?? null;
      return resolvedSlots.find((slot) => slot.slotId === slotId) ?? null;
    },
    [resolvedSlots],
  );

  const isMissingDeclaredSlot = useCallback(
    (slotId: string) => {
      if (slotId === "default") return resolvedSlots.length === 0;
      return !resolvedSlots.some((slot) => slot.slotId === slotId);
    },
    [resolvedSlots],
  );

  const handleStart = useCallback(() => {
    const pluginIds = selectedPluginIds;
    onStart(pluginIds.length > 0 ? pluginIds : undefined);
  }, [selectedPluginIds, onStart]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        initialKey={settingsInitialKey}
      />
      <ScrollArea className="w-full h-full">
        <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 md:py-12">
          {/* Header with Start Game button */}
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="font-display font-bold text-xl md:text-2xl uppercase tracking-widest flex-1">
              {t("session.preparation", "Session Setup")}
            </h1>
            <Button
              size="sm"
              className="uppercase tracking-widest font-bold px-5 shrink-0"
              onClick={handleStart}
            >
              <Play className="w-4 h-4 mr-1.5" />
              {t("session.startGame", "Start Game")}
            </Button>
          </div>
          <div className="mb-8 ml-11">
            <SessionBreadcrumb
              step="prep"
              worldName={text(world.name)}
              onGoWorldSelect={onBack}
            />
          </div>

          {/* World Info */}
          <Card className="mb-4">
            <CollapsibleCardHeader
              expanded={worldInfoExpanded}
              onToggle={() => setWorldInfoExpanded(!worldInfoExpanded)}
              summary={text(world.description) || undefined}
            >
              <MapIcon className="w-4 h-4" />
              {text(world.name)}
              {world.tags && world.tags.length > 0 && (
                <Badge variant="outline" className="text-[10px] ml-1">
                  {world.tags.length} tags
                </Badge>
              )}
            </CollapsibleCardHeader>
            {worldInfoExpanded && (
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                  {text(world.description)}
                </p>
                {world.tags && world.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {world.tags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Existing Sessions */}
          {activeSessions.length > 0 && (
            <Card className="mb-4">
              <CollapsibleCardHeader
                expanded={sessionsExpanded}
                onToggle={() => setSessionsExpanded(!sessionsExpanded)}
                summary={t("session.historySummary", {
                  count: activeSessions.length,
                })}
              >
                <History className="w-4 h-4" />
                {t("session.history", "Previous Sessions")}
                <Badge variant="secondary" className="text-[10px] ml-1">
                  {activeSessions.length}
                </Badge>
              </CollapsibleCardHeader>
              {sessionsExpanded && (
                <CardContent className="space-y-2">
                  {activeSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between border border-border px-4 py-3 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            session.status === "active"
                              ? "bg-green-500"
                              : "bg-muted-foreground"
                          }`}
                        />
                        <div className="min-w-0">
                          <span className="text-xs font-mono text-muted-foreground">
                            {session.id.slice(0, 16)}
                          </span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="text-[10px]">
                              {session.status} · t{session.turnCount}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(session.createdAt).toLocaleString(
                                "zh-CN",
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => onResume(session)}
                        >
                          {t("session.resume")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(session);
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
          )}

          {/* World Lore Editor */}
          <Card className="mb-4">
            <CollapsibleCardHeader
              expanded={loreExpanded}
              onToggle={() => setLoreExpanded(!loreExpanded)}
              summary={
                isLoreModified
                  ? t("session.modified")
                  : t("session.loreSummaryHint", {
                      count: originalLore.length,
                      defaultValue:
                        "{{count}} characters · click to edit world lore",
                    })
              }
            >
              <FileText className="w-4 h-4" />
              {t("session.worldLore", "World Document")}
              {isLoreModified && (
                <Badge variant="secondary" className="text-[10px] ml-1">
                  {t("session.modified")}
                </Badge>
              )}
            </CollapsibleCardHeader>
            {loreExpanded && (
              <CardContent className="space-y-3">
                <textarea
                  value={loreValue}
                  onChange={(e) => handleLoreChange(e.target.value)}
                  className="w-full min-h-[300px] bg-background border border-border px-4 py-3 text-sm font-mono leading-relaxed outline-none focus:ring-1 focus:ring-primary resize-y"
                  placeholder={t("session.lorePlaceholder")}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {isLoreModified
                      ? t("session.loreModified", { count: loreValue.length })
                      : t("session.loreOriginal", {
                          count: originalLore.length,
                        })}
                  </span>
                  {isLoreModified && (
                    <button
                      className="text-xs text-muted-foreground hover:text-primary underline"
                      onClick={resetLore}
                    >
                      {t("session.resetLore", "Reset to original")}
                    </button>
                  )}
                </div>
              </CardContent>
            )}
          </Card>

          {/* Dimension Import/Export */}
          {world.dimensions && (
            <div className="flex items-center gap-2 mb-4 px-1">
              <a href={api.exportDimensionsUrl(world.id)} download>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                >
                  <Download className="w-3 h-3" />
                  {t("session.exportDimensions")}
                </Button>
              </a>
              <DimensionImportButton worldId={world.id} />
            </div>
          )}

          {/* Active Models */}
          <Card className="mb-4">
            <CollapsibleCardHeader
              expanded={modelsExpanded}
              onToggle={() => setModelsExpanded(!modelsExpanded)}
              summary={
                resolvedSlots.length > 0
                  ? t("session.slotsConfigured", {
                      count: resolvedSlots.length,
                    })
                  : t("session.slotsUnconfigured")
              }
            >
              <Cpu className="w-4 h-4" />
              {t("session.activeModels", "Active Models")}
              <Badge variant="secondary" className="text-[10px] ml-1">
                {resolvedSlots.length}
              </Badge>
            </CollapsibleCardHeader>
            {modelsExpanded && (
              <CardContent className="space-y-2">
                <ActiveModelSlots slots={resolvedSlots} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => onSettingsOpenChange(true)}
                >
                  <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                  {t("session.configureKeys", "Configure API Keys & Presets")}
                </Button>
              </CardContent>
            )}
          </Card>

          {/* Plugin Selection & Execution Flow Preview */}
          <Card className="mb-6">
            <CollapsibleCardHeader
              expanded={pluginSectionExpanded}
              onToggle={() => setPluginSectionExpanded(!pluginSectionExpanded)}
              summary={`${selectedPluginIds.length}/${packages.length} ${t("session.pluginsSelected", "plugins selected")} · ${totalRuntimes} runtimes`}
            >
              <Puzzle className="w-4 h-4" />
              {t("session.plugins", "Plugins & Runtimes")}
              <Badge variant="secondary" className="text-[10px] ml-1">
                {selectedPluginIds.length}/{packages.length}
              </Badge>
            </CollapsibleCardHeader>
            {pluginSectionExpanded && (
              <CardContent className="space-y-4">
                {/* Plugin selection grid */}
                <div className="space-y-1.5">
                  {pluginPacks.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
                      {pluginPacks.map((pack) => {
                        const isActive = activePluginPack?.id === pack.id;
                        return (
                          <button
                            key={pack.id}
                            type="button"
                            className={`border px-3 py-2 text-left transition-colors ${
                              isActive
                                ? "border-primary/50 bg-primary/10"
                                : "border-border bg-muted/20 hover:bg-muted/40"
                            }`}
                            onClick={() => applyPack(pack.id)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold truncate">
                                {pack.labelKey
                                  ? t(
                                      pack.labelKey,
                                      textValue(pack.label, i18n.language) ||
                                        pack.id,
                                    )
                                  : textValue(pack.label, i18n.language) ||
                                    pack.id}
                              </span>
                              <Badge
                                variant={isActive ? "secondary" : "outline"}
                                className="text-[9px] shrink-0"
                              >
                                {pack.plugins.length}
                              </Badge>
                            </div>
                            {pack.description && (
                              <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">
                                {pack.descriptionKey
                                  ? t(
                                      pack.descriptionKey,
                                      textValue(
                                        pack.description,
                                        i18n.language,
                                      ),
                                    )
                                  : textValue(pack.description, i18n.language)}
                              </p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex flex-col gap-2 mb-3">
                    <div className="flex items-center gap-2 border border-border bg-background px-2 py-1.5">
                      <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <input
                        value={pluginSearch}
                        onChange={(event) =>
                          setPluginSearch(event.target.value)
                        }
                        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                        placeholder={t(
                          "session.searchPlugins",
                          "Search plugins, tags, capabilities",
                        )}
                      />
                    </div>
                    {availablePluginTags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {availablePluginTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className={`border px-2 py-0.5 text-[10px] transition-colors ${
                              activePluginTags.has(tag)
                                ? "border-primary/50 bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                            onClick={() => togglePluginTag(tag)}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {pluginGroups.map((group) => (
                    <div key={group.id} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 pt-2">
                        <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                          {group.label}
                        </h4>
                        <span className="text-[10px] text-muted-foreground">
                          {group.packages.length}
                        </span>
                      </div>
                      {group.packages.map((pkg) => {
                        const displayName = text(pkg.displayName) || pkg.name;
                        const description = text(pkg.description);
                        const isSelected = selectedPluginIdSet.has(pkg.name);
                        const isLocked = lockedPluginIds.has(pkg.name);
                        const isCore = corePluginIds.has(pkg.name);
                        const reason = recommendationReason(
                          pkg,
                          world,
                          activePluginPack,
                          {
                            locale: i18n.language,
                            requiredByWorld: t(
                              "session.recommendationReasons.requiredByWorld",
                              "Required by world",
                            ),
                            packOptional: t(
                              "session.recommendationReasons.packOptional",
                              "Pack optional",
                            ),
                            recommendedByWorld: t(
                              "session.recommendationReasons.recommendedByWorld",
                              "Recommended by world",
                            ),
                          },
                        );
                        const runtimes = pkg.runtimes ?? [];
                        const tools = pkg.tools ?? [];
                        const pluginBindings = bindingState.entries.filter(
                          (e) => e.pluginId === pkg.name,
                        );
                        const primaryBinding = pluginBindings[0];
                        const hasAgentRuntime = pluginBindings.length > 0;
                        const providerSlotSetting = pkg.userSettings?.find(
                          (spec) => spec.key === "modelPresetId",
                        );
                        const providerSlotName =
                          typeof providerSlotSetting?.default === "string"
                            ? providerSlotSetting.default
                            : undefined;
                        const providerSlotMissing = providerSlotName
                          ? isMissingDeclaredSlot(providerSlotName)
                          : false;
                        const hasMissingRuntimeSlot = pluginBindings.some(
                          (binding) =>
                            isMissingDeclaredSlot(binding.defaultSlot),
                        );

                        return (
                          <div
                            key={pkg.name}
                            className={`border px-3 py-2.5 transition-colors ${
                              isSelected
                                ? "border-primary/40 bg-primary/5"
                                : "border-border bg-muted/20 opacity-60"
                            }`}
                          >
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                              {/* Toggle */}
                              <button
                                type="button"
                                role="switch"
                                aria-checked={isSelected}
                                disabled={isLocked}
                                title={
                                  isLocked ? t("plugin.locked") : undefined
                                }
                                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${
                                  isSelected ? "bg-primary" : "bg-input"
                                } ${isLocked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                                onClick={() =>
                                  !isLocked && togglePlugin(pkg.name)
                                }
                              >
                                <span
                                  className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-sm transition ${
                                    isSelected
                                      ? "translate-x-3"
                                      : "translate-x-0"
                                  }`}
                                />
                              </button>

                              {/* Name + badges */}
                              <span className="text-xs font-medium truncate flex-1 min-w-0">
                                {displayName}
                              </span>
                              {isCore && (
                                <span
                                  title={t("plugin.locked")}
                                  className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground/70 shrink-0"
                                >
                                  <Lock className="w-3 h-3" />
                                  <span className="hidden sm:inline">
                                    {t("plugin.core", "core")}
                                  </span>
                                </span>
                              )}
                              {runtimes[0] && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] shrink-0"
                                >
                                  P{runtimes[0].priority}
                                </Badge>
                              )}
                              {runtimes[0]?.kind && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px] shrink-0"
                                >
                                  {runtimes[0].kind === "agent" ? "LLM" : "Fn"}
                                </Badge>
                              )}
                              {tools.length > 0 && (
                                <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground shrink-0">
                                  <Wrench className="w-2.5 h-2.5" />
                                  {tools.length}
                                </span>
                              )}
                              {/* Inline model slot picker for agent runtimes. Lists
                              every resolved slot (llm.toml + user custom);
                              picking sets localStorage bindings + (once the
                              session is created) PATCHes runtimeModelOverrides
                              via the startGame handler.

                              Hidden when only one slot is resolvable — the
                              dropdown would be a no-op and just adds cognitive
                              load for casual players. P-13 audit finding. */}
                              {hasAgentRuntime &&
                                isSelected &&
                                primaryBinding &&
                                pluginBindings.length === 1 &&
                                !hasMissingRuntimeSlot &&
                                resolvedSlots.length > 1 && (
                                  <select
                                    value={primaryBinding.slotName}
                                    onChange={(e) =>
                                      bindingState.setBinding(
                                        primaryBinding.qualifiedId,
                                        e.target.value,
                                      )
                                    }
                                    className="min-w-[100px] flex-shrink text-[11px] bg-background border border-border rounded px-2 py-1 max-w-[240px]"
                                    aria-label={t(
                                      "plugin.modelBindingAria",
                                      "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
                                    )}
                                    title={t(
                                      "plugin.modelBindingAria",
                                      "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
                                    )}
                                  >
                                    <option value="">
                                      {(() => {
                                        const declared =
                                          primaryBinding.defaultSlot;
                                        const defaultSlot =
                                          resolveDeclaredSlot(declared);
                                        const label =
                                          formatSlotLabel(defaultSlot);
                                        if (label) {
                                          return t(
                                            "plugin.useRuntimeDefaultWith",
                                            {
                                              slot: declared,
                                              value: label,
                                              defaultValue: `Runtime default: ${declared} (${label})`,
                                            },
                                          );
                                        }
                                        return t("plugin.useRuntimeDefault", {
                                          slot: declared,
                                          defaultValue: `Runtime default: ${declared}`,
                                        });
                                      })()}
                                    </option>
                                    {resolvedSlots.map((slot) => (
                                      <option
                                        key={slot.slotId}
                                        value={slot.slotId}
                                      >
                                        {slot.slotId}
                                        {slot.serverModel
                                          ? ` · ${slot.serverModel}`
                                          : ""}
                                      </option>
                                    ))}
                                  </select>
                                )}
                            </div>
                            {description && (
                              <p className="text-[11px] text-muted-foreground mt-1.5 ml-9 line-clamp-2">
                                {description}
                              </p>
                            )}
                            <div className="mt-1.5 ml-9 flex flex-wrap gap-1">
                              {reason && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px] px-1.5 py-0 h-4"
                                >
                                  {reason}
                                </Badge>
                              )}
                              {(pkg.tags ?? []).slice(0, 4).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="outline"
                                  className="text-[9px] px-1.5 py-0 h-4 text-muted-foreground"
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                            {isSelected && providerSlotName && (
                              <div className="mt-2.5 ml-9 flex items-center gap-2.5 text-[11px] text-muted-foreground">
                                <KeyRound className="w-3 h-3 shrink-0" />
                                <span className="font-medium shrink-0">
                                  {t("plugin.providerSlot", "provider slot")}
                                </span>
                                <Badge
                                  variant={
                                    providerSlotMissing
                                      ? "destructive"
                                      : "outline"
                                  }
                                  className="text-[10px] px-1.5 py-0.5 h-5 shrink-0"
                                  title={
                                    providerSlotMissing
                                      ? t("plugin.providerSlotMissingTitle", {
                                          slot: providerSlotName,
                                          plugin: pkg.name,
                                          defaultValue:
                                            "Add [covel.{{slot}}] to llm.toml, or change {{plugin}}.modelPresetId in Settings > Plugins.",
                                        })
                                      : undefined
                                  }
                                >
                                  {providerSlotMissing
                                    ? t("plugin.slotMissingShort", {
                                        slot: providerSlotName,
                                        defaultValue:
                                          "missing [covel.{{slot}}]",
                                      })
                                    : `[covel.${providerSlotName}]`}
                                </Badge>
                                <span className="truncate">
                                  {providerSlotMissing
                                    ? t("plugin.providerSlotMissingDetail", {
                                        slot: providerSlotName,
                                        plugin: pkg.name,
                                        defaultValue:
                                          "Configure [covel.{{slot}}] in llm.toml, or change modelPresetId in Settings > Plugins > {{plugin}}.",
                                      })
                                    : t("plugin.providerSlotSettingDetail", {
                                        plugin: pkg.name,
                                        defaultValue:
                                          "from plugin setting modelPresetId; edit in Settings > Plugins > {{plugin}}",
                                      })}
                                </span>
                              </div>
                            )}
                            {isSelected &&
                              pluginBindings.length > 0 &&
                              (pluginBindings.length > 1 ||
                                hasMissingRuntimeSlot) && (
                                <div className="mt-2.5 ml-9 space-y-1.5">
                                  {pluginBindings.map((binding) => {
                                    const declaredSlot = binding.defaultSlot;
                                    const configuredDefault =
                                      resolveDeclaredSlot(declaredSlot);
                                    const selectedSlot = binding.slotName
                                      ? resolvedSlots.find(
                                          (s) => s.slotId === binding.slotName,
                                        )
                                      : configuredDefault;
                                    const missingDefault =
                                      isMissingDeclaredSlot(declaredSlot);
                                    const showPicker =
                                      pluginBindings.length > 1 ||
                                      missingDefault ||
                                      resolvedSlots.length > 1;
                                    return (
                                      <div
                                        key={binding.qualifiedId}
                                        className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground min-w-0"
                                      >
                                        <Cpu className="w-3 h-3 shrink-0" />
                                        <span
                                          className="font-mono truncate min-w-0 max-w-[240px]"
                                          title={binding.qualifiedId}
                                        >
                                          {binding.qualifiedId}
                                        </span>
                                        <Badge
                                          variant={
                                            missingDefault
                                              ? "destructive"
                                              : "outline"
                                          }
                                          className="text-[10px] px-1.5 py-0.5 h-5 shrink-0"
                                          title={
                                            missingDefault
                                              ? t("plugin.slotMissingTitle", {
                                                  slot: declaredSlot,
                                                  defaultValue:
                                                    "Add [covel.{{slot}}] to llm.toml",
                                                })
                                              : undefined
                                          }
                                        >
                                          {missingDefault
                                            ? t("plugin.slotMissingShort", {
                                                slot: declaredSlot,
                                                defaultValue:
                                                  "missing [covel.{{slot}}]",
                                              })
                                            : `default: ${declaredSlot}`}
                                        </Badge>
                                        {missingDefault && (
                                          <code className="text-[10px] text-muted-foreground/80 bg-muted px-1.5 py-0.5 rounded shrink-0">
                                            [covel.{declaredSlot}]
                                          </code>
                                        )}
                                        {showPicker ? (
                                          <select
                                            value={binding.slotName}
                                            onChange={(e) =>
                                              bindingState.setBinding(
                                                binding.qualifiedId,
                                                e.target.value,
                                              )
                                            }
                                            className="ml-auto min-w-[120px] flex-shrink text-[11px] bg-background border border-border rounded px-2 py-1 max-w-[280px]"
                                            aria-label={t(
                                              "plugin.modelBindingAria",
                                              "Which model slot this plugin's runtime will use. Leave at default unless you have a reason to override.",
                                            )}
                                          >
                                            <option value="">
                                              {configuredDefault
                                                ? configuredDefault.serverModel
                                                  ? t(
                                                      "plugin.runtimeDefaultSummaryWithModel",
                                                      {
                                                        slot: declaredSlot,
                                                        model:
                                                          configuredDefault.serverModel,
                                                        defaultValue:
                                                          "runtime default · {{slot}} · {{model}}",
                                                      },
                                                    )
                                                  : t(
                                                      "plugin.runtimeDefaultSummary",
                                                      {
                                                        slot: declaredSlot,
                                                        defaultValue:
                                                          "runtime default · {{slot}}",
                                                      },
                                                    )
                                                : t(
                                                    "plugin.runtimeDefaultMissing",
                                                    {
                                                      slot: declaredSlot,
                                                      defaultValue:
                                                        "runtime default · {{slot}} (missing)",
                                                    },
                                                  )}
                                            </option>
                                            {resolvedSlots.map((slot) => (
                                              <option
                                                key={slot.slotId}
                                                value={slot.slotId}
                                              >
                                                {slot.slotId}
                                                {slot.serverModel
                                                  ? ` · ${slot.serverModel}`
                                                  : ""}
                                              </option>
                                            ))}
                                          </select>
                                        ) : selectedSlot ? (
                                          <span
                                            className="ml-auto truncate text-[11px]"
                                            title={
                                              formatSlotLabel(selectedSlot) ??
                                              selectedSlot.slotId
                                            }
                                          >
                                            {formatSlotLabel(selectedSlot) ??
                                              selectedSlot.slotId}
                                          </span>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

                <WorldDataPreflightPanel
                  result={worldDataPreflight}
                  status={worldDataPreflightStatus}
                  error={worldDataPreflightError}
                  onRetry={runWorldDataPreflight}
                />

                {/* Execution Flow Preview */}
                {selectedFlowSteps.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-dashed border-border">
                    <div className="space-y-0.5">
                      <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                        <Zap className="w-3 h-3" />
                        {t("session.executionFlow", "Execution Flow")}
                      </h4>
                      <p
                        className="text-[10px] text-muted-foreground/70 leading-snug"
                        title={t(
                          "session.executionFlowTitle",
                          "Plugins run in priority order every turn. Pre-Turn and After-Turn band the narrator on either side.",
                        )}
                      >
                        {t(
                          "session.executionFlowHint",
                          "Turn order — lower priority runs first.",
                        )}
                      </p>
                    </div>
                    <div className="space-y-1">
                      {(flowData?.segments ?? []).map((seg) => {
                        const stepsInSeg = selectedFlowSteps
                          .filter(
                            (s) =>
                              s.priority >= seg.range[0] &&
                              s.priority <= seg.range[1],
                          )
                          .sort((a, b) => a.priority - b.priority);
                        if (stepsInSeg.length === 0) return null;
                        return (
                          <div key={seg.label}>
                            <div className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">
                              {seg.label}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {stepsInSeg.map((step) => {
                                // qualifiedId is the canonical runtime id
                                // (pluginId or pluginId/runtimeName); match on
                                // step.runtimeId, falling back to pluginId for
                                // single-runtime plugins where both carry the
                                // same value.
                                const bindingEntry = bindingState.entries.find(
                                  (e) =>
                                    e.qualifiedId === step.runtimeId ||
                                    e.qualifiedId === step.pluginId,
                                );
                                return (
                                  <div
                                    key={step.runtimeId}
                                    className="inline-flex items-center gap-1.5 bg-muted/40 border border-border px-2 py-1 text-[10px]"
                                    title={`${step.runtimeId} — P${step.priority} — ${step.trigger.mode}`}
                                  >
                                    <span className="text-[8px] text-muted-foreground font-mono">
                                      P{step.priority}
                                    </span>
                                    <span className="font-medium truncate max-w-[120px]">
                                      {step.label}
                                    </span>
                                    {step.runtimeType === "agent" && (
                                      <Cpu className="w-2.5 h-2.5 text-muted-foreground" />
                                    )}
                                    {bindingEntry?.slotName && (
                                      <Badge
                                        variant="outline"
                                        className="text-[8px] px-1 py-0 h-3"
                                      >
                                        {bindingEntry.slotName}
                                      </Badge>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Model Assignments section removed — each plugin row now
                    carries its own inline slot picker in the header above. If
                    multi-runtime plugins ever need per-runtime binding in the
                    prep screen, resurrect this list but gate it behind an
                    "advanced" toggle so it doesn't duplicate the inline UI. */}
              </CardContent>
            )}
          </Card>
        </div>
      </ScrollArea>

      {/* Delete confirmation dialog */}
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

function WorldDataPreflightPanel({
  result,
  status,
  error,
  onRetry,
}: {
  result: api.WorldDataPreflightResponse | null;
  status: "idle" | "loading" | "success" | "error";
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const diagnostics = result?.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.level === "error");
  const warnings = diagnostics.filter((item) => item.level === "warning");
  const visibleDiagnostics = diagnostics
    .filter((item) => item.level !== "info")
    .slice(0, 3);
  const visibleTargets = result?.targets.slice(0, 3) ?? [];
  const moreTargets = Math.max((result?.targets.length ?? 0) - 3, 0);
  const badge =
    status === "loading"
      ? t("session.worldDataPreflight.loading", "Checking")
      : status === "error"
        ? t("session.worldDataPreflight.failed", "Check failed")
        : result?.imported === false
          ? t("session.worldDataPreflight.empty", "No import plan")
          : errors.length > 0
            ? t("session.worldDataPreflight.errors", {
                count: errors.length,
                defaultValue: "{{count}} error(s)",
              })
            : warnings.length > 0
              ? t("session.worldDataPreflight.warnings", {
                  count: warnings.length,
                  defaultValue: "{{count}} warning(s)",
                })
              : t("session.worldDataPreflight.ready", {
                  count: result?.planned ?? 0,
                  defaultValue: "{{count}} item(s)",
                });

  return (
    <div className="space-y-2 border-t border-dashed border-border pt-3">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-muted-foreground" />
        <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
          {t("session.worldDataPreflight.title", "World Data")}
        </h4>
        <Badge
          variant={
            errors.length > 0 || status === "error"
              ? "destructive"
              : "secondary"
          }
          className="text-[9px] ml-auto"
        >
          {status === "loading" && (
            <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />
          )}
          {badge}
        </Badge>
      </div>

      {status === "error" && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-destructive">
          <span className="truncate">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px]"
            onClick={onRetry}
          >
            {t("session.worldDataPreflight.retry", "Retry")}
          </Button>
        </div>
      )}

      {status === "success" && result?.imported === false && (
        <p className="text-[11px] text-muted-foreground">
          {t(
            "session.worldDataPreflight.emptyDetail",
            "This world has no worldData import plan.",
          )}
        </p>
      )}

      {visibleDiagnostics.length > 0 && (
        <div className="space-y-1">
          {visibleDiagnostics.map((item, index) => (
            <div
              key={`${item.sourceId ?? "world"}-${index}`}
              className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            >
              <AlertTriangle
                className={`w-3 h-3 mt-0.5 shrink-0 ${
                  item.level === "error" ? "text-destructive" : "text-amber-500"
                }`}
              />
              <span className="break-words [overflow-wrap:anywhere]">
                {item.sourceId ? `${item.sourceId}: ` : ""}
                {item.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {visibleTargets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {visibleTargets.map((target, index) => (
            <Badge
              key={`${target.target}-${target.key ?? index}`}
              variant="outline"
              className="max-w-full text-[9px] font-mono"
              title={`${target.kind} ${target.target}${target.key ? `:${target.key}` : ""}`}
            >
              <span className="truncate max-w-[220px]">
                {target.target}
                {target.key ? `:${target.key}` : ""}
              </span>
            </Badge>
          ))}
          {moreTargets > 0 && (
            <Badge variant="outline" className="text-[9px]">
              {t("session.worldDataPreflight.moreTargets", {
                count: moreTargets,
                defaultValue: "{{count}} more",
              })}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dimension Import Button ───────────────────────────────────────

function DimensionImportButton({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState("");

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setStatus("loading");
      setMessage("");

      try {
        const text = await file.text();

        let dimensions: Record<string, unknown>;
        if (file.name.endsWith(".json")) {
          dimensions = JSON.parse(text) as Record<string, unknown>;
        } else {
          // YAML — dynamically import yaml parser
          const { parse } = await import("yaml");
          dimensions = parse(text) as Record<string, unknown>;
        }

        await api.importDimensions(worldId, dimensions);
        setStatus("success");
        setMessage(t("session.dimensionsImported"));
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }

      // Reset file input so same file can be re-selected
      e.target.value = "";
    },
    [worldId, t],
  );

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1.5 relative"
        disabled={status === "loading"}
        asChild
      >
        <label>
          <Upload className="w-3 h-3" />
          {t("session.importDimensions")}
          <input
            type="file"
            accept=".yaml,.yml,.json"
            className="sr-only"
            onChange={handleFileSelect}
          />
        </label>
      </Button>
      {message && (
        <span
          className={`text-[10px] ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </span>
      )}
    </div>
  );
}
