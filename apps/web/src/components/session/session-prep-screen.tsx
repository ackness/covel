import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  MapIcon, Play, ArrowLeft, ChevronDown, ChevronUp, FileText,
  Cpu, KeyRound, History, Trash2, Link2,
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
import { RuntimeBindingPanel } from "./runtime-binding-panel.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useRuntimeBindings } from "@/hooks/use-runtime-bindings.js";

interface SessionPrepScreenProps {
  world: api.WorldRecord;
  packages: api.PackageSummary[];
  presets: api.PresetSummary[];
  llmConfig?: api.LlmConfigResponse | null;
  onBack: () => void;
  onStart: () => void;
  onResume: (session: api.SessionRecord) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
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
  const enabledPackages = packages.filter((p) => p.enabled);
  const bindingState = useRuntimeBindings(`prep:${world.id}`, enabledPackages, resolvedSlots);

  const [priorityOverrides, setPriorityOverrides] = useState<Record<string, number>>(() =>
    api.getRuntimePriorityOverrides()
  );
  const [pluginSectionExpanded, setPluginSectionExpanded] = useState(false);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [existingSessions, setExistingSessions] = useState<api.SessionRecord[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<api.SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Fetch existing sessions for this world
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
  const [loreExpanded, setLoreExpanded] = useState(false);
  const originalLore = text(world.lore);
  const isLoreModified = loreValue !== originalLore;

  // Load world overlay from IDB on mount
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

  const togglePlugin = (name: string) => {
    setExpandedPlugins((prev) => {
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

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog open={settingsOpen} onOpenChange={handleSettingsOpenChange} />
      <ScrollArea className="w-full h-full">
        <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 md:py-12">
          {/* Header */}
          <div className="flex items-center gap-3 mb-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <h1 className="font-display font-bold text-xl md:text-2xl uppercase tracking-widest">
              {t("session.preparation", "Session Setup")}
            </h1>
          </div>
          <div className="mb-8 ml-11">
            <SessionBreadcrumb step="prep" worldName={text(world.name)} onGoWorldSelect={onBack} />
          </div>

          {/* World Info */}
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MapIcon className="w-4 h-4" />
                {text(world.name)}
              </CardTitle>
            </CardHeader>
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
          </Card>

          {/* Existing Sessions */}
          {activeSessions.length > 0 && (
            <Card className="mb-6">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <History className="w-4 h-4" />
                  {t("session.history", "Previous Sessions")}
                  <Badge variant="secondary" className="text-[10px] ml-1">{activeSessions.length}</Badge>
                </CardTitle>
              </CardHeader>
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
            </Card>
          )}

          {/* World Lore Editor */}
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <button
                className="w-full flex items-center justify-between text-left"
                onClick={() => setLoreExpanded(!loreExpanded)}
              >
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="w-4 h-4" />
                  {t("session.worldLore", "World Document")}
                  {isLoreModified && (
                    <Badge variant="secondary" className="text-[10px] ml-1">{t("session.modified")}</Badge>
                  )}
                </CardTitle>
                {loreExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </CardHeader>
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

          {/* Active Models */}
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="w-4 h-4" />
                {t("session.activeModels", "Active Models")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ActiveModelSlots slots={resolvedSlots} />
              <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => onSettingsOpenChange(true)}>
                <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                {t("session.configureKeys", "Configure API Keys & Presets")}
              </Button>
            </CardContent>
          </Card>

          {/* Runtime Model Bindings */}
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2 className="w-4 h-4" />
                {t("session.runtimeBindings", "Runtime Model Bindings")}
                {!bindingState.allBound && (
                  <Badge variant="secondary" className="text-[10px] ml-1 bg-amber-500/10 text-amber-600">
                    {t("session.needsConfig", "Needs config")}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RuntimeBindingPanel bindingState={bindingState} />
            </CardContent>
          </Card>

          {/* Plugin & Runtime Configuration */}
          <Card className="mb-8">
            <CardHeader className="pb-2">
              <button
                className="w-full flex items-center justify-between text-left"
                onClick={() => setPluginSectionExpanded(!pluginSectionExpanded)}
              >
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cpu className="w-4 h-4" />
                  {t("session.plugins", "Plugins & Runtimes")}
                  {enabledPackages.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] ml-1">
                      {enabledPackages.length}
                    </Badge>
                  )}
                </CardTitle>
                {pluginSectionExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {!pluginSectionExpanded && enabledPackages.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {enabledPackages.length} 个插件已加载，共{" "}
                  {enabledPackages.reduce((sum, p) => sum + (p.runtimes?.length ?? 0), 0)} 个 runtime
                </p>
              )}
            </CardHeader>
            {pluginSectionExpanded && (
            <CardContent className="space-y-2">
              {enabledPackages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">{t("session.noPluginsLoaded")}</p>
              ) : (
                enabledPackages.map((pkg) => {
                  const isExpanded = expandedPlugins.has(pkg.name);
                  const displayName = typeof pkg.displayName === "string"
                    ? pkg.displayName
                    : (pkg.displayName as Record<string, string> | undefined)?.["zh-CN"] ?? pkg.name;
                  const description = typeof pkg.description === "string"
                    ? pkg.description
                    : (pkg.description as Record<string, string> | undefined)?.["zh-CN"];

                  return (
                    <div key={pkg.name} className="border border-border">
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                        onClick={() => togglePlugin(pkg.name)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {pkg.runtimes?.length ?? 0} runtime{(pkg.runtimes?.length ?? 0) !== 1 ? "s" : ""}
                          </Badge>
                          <span className="text-sm font-medium truncate">{displayName}</span>
                        </div>
                        {isExpanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
                      </button>
                      {isExpanded && (
                        <div className="px-4 pb-3 space-y-3 border-t border-border pt-3">
                          {description && (
                            <p className="text-xs text-muted-foreground">{description}</p>
                          )}
                          {pkg.runtimes && pkg.runtimes.length > 0 ? (
                            <div className="space-y-2">
                              {pkg.runtimes.map((rt) => {
                                const qualifiedId = `${pkg.name}:${rt.id}`;
                                const effectivePriority = priorityOverrides[qualifiedId] ?? rt.priority;
                                const isOverridden = qualifiedId in priorityOverrides;
                                return (
                                  <div key={rt.id} className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="text-xs font-mono truncate">{rt.id}</span>
                                      <Badge variant="secondary" className="text-[10px] shrink-0">{rt.kind}</Badge>
                                      {rt.providerTag && (
                                        <Badge variant="outline" className="text-[10px] shrink-0">{rt.providerTag}</Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <span className="text-[10px] text-muted-foreground uppercase">{t("session.priority")}</span>
                                      <input
                                        type="number"
                                        min={0}
                                        max={1000}
                                        value={effectivePriority}
                                        onChange={(e) => handlePriorityChange(qualifiedId, e.target.value)}
                                        className={`w-16 bg-background border px-2 py-1 text-xs text-center outline-none focus:ring-1 focus:ring-primary ${
                                          isOverridden ? "border-primary" : "border-border"
                                        }`}
                                      />
                                      {isOverridden && (
                                        <button
                                          className="text-[10px] text-muted-foreground hover:text-primary underline"
                                          onClick={() => resetPriority(qualifiedId)}
                                        >
                                          {t("session.reset")}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">{t("session.noRuntimes")}</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
            )}
          </Card>

          {/* Start Game Button */}
          <div className="flex justify-center">
            <Button
              size="lg"
              className="px-12 py-6 text-base uppercase tracking-widest font-bold"
              onClick={onStart}
            >
              <Play className="w-5 h-5 mr-2" />
              {t("session.startGame", "Start Game")}
            </Button>
          </div>
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
