import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  MapIcon, Play, ArrowLeft, ChevronDown, ChevronUp, FileText,
  Cpu, KeyRound, History, Trash2, Download, Upload,
  Puzzle, Lock, Zap, Wrench,
} from "lucide-react";
import * as api from "@/services/api.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { text } from "@/components/world/editor-helpers.js";
import { ActiveModelSlots } from "./active-model-slots.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useRuntimeBindings } from "@/hooks/use-runtime-bindings.js";

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
        {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
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
}: SessionPrepScreenProps) {
  const { t } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(presets, llmConfig);

  // Plugin selection state — default all enabled
  const [selectedPlugins, setSelectedPlugins] = useState<Set<string>>(() =>
    new Set(packages.filter((p) => p.enabled).map((p) => p.name)),
  );
  const selectedPackages = useMemo(
    () => packages.filter((p) => selectedPlugins.has(p.name)),
    [packages, selectedPlugins],
  );
  const bindingState = useRuntimeBindings(`prep:${world.id}`, selectedPackages, resolvedSlots);

  // Plugin flow data for execution preview
  const [flowData, setFlowData] = useState<api.PluginFlowResponse | null>(null);
  useEffect(() => {
    api.fetchPluginFlows().then(setFlowData).catch(() => {});
  }, []);

  const togglePlugin = useCallback((name: string) => {
    setSelectedPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Determine core plugins that cannot be deselected
  const corePluginIds = useMemo(
    () => new Set(packages.filter((p) => p.pluginType === "builtin").map((p) => p.name)),
    [packages],
  );

  // Section expand state — all collapsed by default except plugins
  const [worldInfoExpanded, setWorldInfoExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [loreExpanded, setLoreExpanded] = useState(false);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [pluginSectionExpanded, setPluginSectionExpanded] = useState(true);

  const [priorityOverrides, setPriorityOverrides] = useState<Record<string, number>>(() =>
    api.getRuntimePriorityOverrides()
  );
  const [expandedPlugins, setExpandedPluginsList] = useState<Set<string>>(new Set());
  const [existingSessions, setExistingSessions] = useState<api.SessionRecord[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<api.SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.listSessions(world.id).then(setExistingSessions).catch(() => {});
  }, [world.id]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteSession(deleteTarget.id);
      setExistingSessions((prev) => prev.filter((s) => s.id !== deleteTarget.id));
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
      void api.setWorldOverlay(world.id, { lore: value, updatedAt: new Date().toISOString() });
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
      if (next.has(name)) next.delete(name); else next.add(name);
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

  const activeSessions = existingSessions.filter((s) => s.status !== "archived");
  const totalRuntimes = selectedPackages.reduce((sum, p) => sum + (p.runtimes?.length ?? 0), 0);

  // Build flow steps filtered by selected plugins
  const selectedFlowSteps = useMemo(() => {
    if (!flowData) return [];
    return flowData.steps.filter((s) => selectedPlugins.has(s.pluginId));
  }, [flowData, selectedPlugins]);

  const handleStart = useCallback(() => {
    const pluginIds = [...selectedPlugins];
    onStart(pluginIds.length > 0 ? pluginIds : undefined);
  }, [selectedPlugins, onStart]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog open={settingsOpen} onOpenChange={handleSettingsOpenChange} />
      <ScrollArea className="w-full h-full">
        <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 md:py-12">

          {/* Header with Start Game button */}
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack}>
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
            <SessionBreadcrumb step="prep" worldName={text(world.name)} onGoWorldSelect={onBack} />
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
                <Badge variant="outline" className="text-[10px] ml-1">{world.tags.length} tags</Badge>
              )}
            </CollapsibleCardHeader>
            {worldInfoExpanded && (
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">{text(world.description)}</p>
                {world.tags && world.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {world.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
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
                summary={t("session.historySummary", { count: activeSessions.length })}
              >
                <History className="w-4 h-4" />
                {t("session.history", "Previous Sessions")}
                <Badge variant="secondary" className="text-[10px] ml-1">{activeSessions.length}</Badge>
              </CollapsibleCardHeader>
              {sessionsExpanded && (
                <CardContent className="space-y-2">
                  {activeSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between border border-border px-4 py-3 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${
                          session.status === "active" ? "bg-green-500" : "bg-muted-foreground"
                        }`} />
                        <div className="min-w-0">
                          <span className="text-xs font-mono text-muted-foreground">{session.id.slice(0, 16)}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="text-[10px]">{session.phase}</Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(session.createdAt).toLocaleString("zh-CN")}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button variant="outline" size="sm" className="text-xs" onClick={() => onResume(session)}>
                          {t("session.resume")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(session); }}
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
              summary={isLoreModified ? t("session.modified") : t("session.loreSummary", { count: originalLore.length })}
            >
              <FileText className="w-4 h-4" />
              {t("session.worldLore", "World Document")}
              {isLoreModified && (
                <Badge variant="secondary" className="text-[10px] ml-1">{t("session.modified")}</Badge>
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
                      : t("session.loreOriginal", { count: originalLore.length })}
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
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
                  <Download className="w-3 h-3" />
                  {t("session.exportDimensions", "导出维度")}
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
              summary={resolvedSlots.length > 0 ? t("session.slotsConfigured", { count: resolvedSlots.length }) : t("session.slotsUnconfigured")}
            >
              <Cpu className="w-4 h-4" />
              {t("session.activeModels", "Active Models")}
              <Badge variant="secondary" className="text-[10px] ml-1">{resolvedSlots.length}</Badge>
            </CollapsibleCardHeader>
            {modelsExpanded && (
              <CardContent className="space-y-2">
                <ActiveModelSlots slots={resolvedSlots} />
                <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => onSettingsOpenChange(true)}>
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
              summary={`${selectedPlugins.size}/${packages.length} ${t("session.pluginsSelected", "plugins selected")} · ${totalRuntimes} runtimes`}
            >
              <Puzzle className="w-4 h-4" />
              {t("session.plugins", "Plugins & Runtimes")}
              <Badge variant="secondary" className="text-[10px] ml-1">
                {selectedPlugins.size}/{packages.length}
              </Badge>
            </CollapsibleCardHeader>
            {pluginSectionExpanded && (
              <CardContent className="space-y-4">
                {/* Plugin selection grid */}
                <div className="space-y-1.5">
                  {packages.map((pkg) => {
                    const displayName = text(pkg.displayName) || pkg.name;
                    const description = text(pkg.description);
                    const isSelected = selectedPlugins.has(pkg.name);
                    const isCore = corePluginIds.has(pkg.name);
                    const runtimes = pkg.runtimes ?? [];
                    const tools = pkg.tools ?? [];

                    return (
                      <div
                        key={pkg.name}
                        className={`border px-3 py-2.5 transition-colors ${
                          isSelected
                            ? "border-primary/40 bg-primary/5"
                            : "border-border bg-muted/20 opacity-60"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {/* Toggle */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isSelected}
                            disabled={isCore}
                            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${
                              isSelected ? "bg-primary" : "bg-input"
                            } ${isCore ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                            onClick={() => !isCore && togglePlugin(pkg.name)}
                          >
                            <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow-sm transition ${
                              isSelected ? "translate-x-3" : "translate-x-0"
                            }`} />
                          </button>

                          {/* Name + badges */}
                          <span className="text-xs font-medium truncate flex-1">{displayName}</span>
                          {isCore && <span title={t("plugin.locked")}><Lock className="w-3 h-3 text-muted-foreground/50 shrink-0" /></span>}
                          {runtimes[0] && (
                            <Badge variant="outline" className="text-[9px] shrink-0">
                              P{runtimes[0].priority}
                            </Badge>
                          )}
                          {runtimes[0]?.kind && (
                            <Badge variant="secondary" className="text-[9px] shrink-0">
                              {runtimes[0].kind === "agent" ? "LLM" : "Fn"}
                            </Badge>
                          )}
                          {tools.length > 0 && (
                            <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground shrink-0">
                              <Wrench className="w-2.5 h-2.5" />{tools.length}
                            </span>
                          )}
                        </div>
                        {description && (
                          <p className="text-[10px] text-muted-foreground mt-1 ml-9 line-clamp-1">{description}</p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Execution Flow Preview */}
                {selectedFlowSteps.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-dashed border-border">
                    <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                      <Zap className="w-3 h-3" />
                      {t("session.executionFlow", "Execution Flow")}
                    </h4>
                    <div className="space-y-1">
                      {(flowData?.segments ?? []).map((seg) => {
                        const stepsInSeg = selectedFlowSteps
                          .filter((s) => s.priority >= seg.range[0] && s.priority <= seg.range[1])
                          .sort((a, b) => a.priority - b.priority);
                        if (stepsInSeg.length === 0) return null;
                        return (
                          <div key={seg.label}>
                            <div className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mb-0.5">
                              {seg.label}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {stepsInSeg.map((step) => {
                                const bindingEntry = bindingState.entries.find(
                                  (e) => e.qualifiedId === `${step.pluginId}:${step.runtimeId}`,
                                );
                                return (
                                  <div
                                    key={step.runtimeId}
                                    className="inline-flex items-center gap-1.5 bg-muted/40 border border-border px-2 py-1 text-[10px]"
                                    title={`${step.runtimeId} — P${step.priority} — ${step.trigger.mode}`}
                                  >
                                    <span className="text-[8px] text-muted-foreground font-mono">P{step.priority}</span>
                                    <span className="font-medium truncate max-w-[120px]">{step.label}</span>
                                    {step.runtimeType === "agent" && (
                                      <Cpu className="w-2.5 h-2.5 text-muted-foreground" />
                                    )}
                                    {bindingEntry?.slotName && (
                                      <Badge variant="outline" className="text-[8px] px-1 py-0 h-3">
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

                {/* Model binding section for selected agent runtimes */}
                {bindingState.entries.length > 0 && resolvedSlots.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-dashed border-border">
                    <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                      <Cpu className="w-3 h-3" />
                      {t("session.modelBindings", "Model Assignments")}
                    </h4>
                    <div className="space-y-1">
                      {bindingState.entries
                        .filter((e) => selectedPlugins.has(e.pluginId))
                        .map((entry) => {
                          const compatSlots = bindingState.compatibleSlots(entry.providerTag);
                          return (
                            <div key={entry.qualifiedId} className="flex items-center gap-2">
                              <span className="text-[10px] font-mono text-muted-foreground truncate w-40 shrink-0">{entry.qualifiedId.split(":").pop()}</span>
                              <select
                                value={entry.slotName}
                                onChange={(e) => bindingState.setBinding(entry.qualifiedId, e.target.value)}
                                className="flex-1 bg-background border border-border px-2 py-1 text-[10px] outline-none focus:ring-1 focus:ring-primary"
                              >
                                <option value="">auto (default)</option>
                                {compatSlots.map((slot) => (
                                  <option key={slot.slotId} value={slot.slotId}>
                                    {slot.slotId}{slot.serverModel ? ` — ${slot.serverModel}` : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

        </div>
      </ScrollArea>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("session.deleteConfirmTitle", "Delete Session")}</DialogTitle>
            <DialogDescription>
              {t("session.deleteConfirmDesc", "This will permanently delete the session and all its data (messages, game state, etc.). This action cannot be undone.")}
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
            <Button variant="destructive" size="sm" disabled={deleting} onClick={handleConfirmDelete}>
              {deleting ? t("common.deleting", "Deleting...") : t("common.delete", "Delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Dimension Import Button ───────────────────────────────────────

function DimensionImportButton({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
      setMessage(t("session.dimensionsImported", "导入成功"));
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }

    // Reset file input so same file can be re-selected
    e.target.value = "";
  }, [worldId, t]);

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
          {t("session.importDimensions", "导入维度")}
          <input
            type="file"
            accept=".yaml,.yml,.json"
            className="sr-only"
            onChange={handleFileSelect}
          />
        </label>
      </Button>
      {message && (
        <span className={`text-[10px] ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
