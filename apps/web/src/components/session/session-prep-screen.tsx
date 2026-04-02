import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  MapIcon, Play, ArrowLeft, ChevronDown, ChevronUp, FileText,
  Cpu, KeyRound, History,
} from "lucide-react";
import * as api from "@/services/api.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { ActiveModelSlots } from "./active-model-slots.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";

interface SessionPrepScreenProps {
  world: api.WorldRecord;
  packages: api.PackageSummary[];
  presets: api.PresetSummary[];
  onBack: () => void;
  onStart: () => void;
  onResume: (session: api.SessionRecord) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
}

export function SessionPrepScreen({
  world,
  packages,
  presets,
  onBack,
  onStart,
  onResume,
  settingsOpen,
  onSettingsOpenChange,
}: SessionPrepScreenProps) {
  const { t } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(presets);

  const [priorityOverrides, setPriorityOverrides] = useState<Record<string, number>>(() =>
    api.getRuntimePriorityOverrides()
  );
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [existingSessions, setExistingSessions] = useState<api.SessionRecord[]>([]);

  // Fetch existing sessions for this world
  useEffect(() => {
    api.listSessions(world.id).then(setExistingSessions).catch(() => {});
  }, [world.id]);

  const [loreValue, setLoreValue] = useState<string>(() => {
    const overlay = api.getWorldOverlay(world.id);
    return overlay?.lore ?? world.lore ?? "";
  });
  const [loreExpanded, setLoreExpanded] = useState(false);
  const originalLore = world.lore ?? "";
  const isLoreModified = loreValue !== originalLore;

  const handleLoreChange = (value: string) => {
    setLoreValue(value);
    if (value !== originalLore) {
      api.setWorldOverlay(world.id, { lore: value, updatedAt: new Date().toISOString() });
    } else {
      api.removeWorldOverlay(world.id);
    }
  };

  const resetLore = () => {
    setLoreValue(originalLore);
    api.removeWorldOverlay(world.id);
  };

  const togglePlugin = (name: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handlePriorityChange = (runtimeId: string, value: string) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0 || num > 1000) return;
    const updated = { ...priorityOverrides, [runtimeId]: num };
    setPriorityOverrides(updated);
    api.setRuntimePriorityOverrides(updated);
  };

  const resetPriority = (runtimeId: string) => {
    const updated = { ...priorityOverrides };
    delete updated[runtimeId];
    setPriorityOverrides(updated);
    api.setRuntimePriorityOverrides(updated);
  };

  const handleSettingsOpenChange = (v: boolean) => {
    onSettingsOpenChange(v);
    if (!v) refreshSlots();
  };

  const enabledPackages = packages.filter((p) => p.enabled);
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
            <SessionBreadcrumb step="prep" worldName={world.name} onGoWorldSelect={onBack} />
          </div>

          {/* World Info */}
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MapIcon className="w-4 h-4" />
                {world.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">{world.description}</p>
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
                    <Button variant="outline" size="sm" className="text-xs shrink-0" onClick={() => onResume(session)}>
                      Resume
                    </Button>
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
                    <Badge variant="secondary" className="text-[10px] ml-1">modified</Badge>
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
                  placeholder="Enter world lore in Markdown..."
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {isLoreModified
                      ? `Modified (${loreValue.length} chars)`
                      : `Original (${originalLore.length} chars)`}
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

          {/* Plugin & Runtime Configuration */}
          <Card className="mb-8">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="w-4 h-4" />
                {t("session.plugins", "Plugins & Runtimes")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {enabledPackages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No plugins loaded</p>
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
                                const effectivePriority = priorityOverrides[rt.id] ?? rt.priority;
                                const isOverridden = rt.id in priorityOverrides;
                                return (
                                  <div key={rt.id} className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="text-xs font-mono truncate">{rt.id}</span>
                                      <Badge variant="secondary" className="text-[10px] shrink-0">{rt.kind}</Badge>
                                      {rt.providerBinding && (
                                        <Badge variant="outline" className="text-[10px] shrink-0">{rt.providerBinding}</Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <span className="text-[10px] text-muted-foreground uppercase">Priority</span>
                                      <input
                                        type="number"
                                        min={0}
                                        max={1000}
                                        value={effectivePriority}
                                        onChange={(e) => handlePriorityChange(rt.id, e.target.value)}
                                        className={`w-16 bg-background border px-2 py-1 text-xs text-center outline-none focus:ring-1 focus:ring-primary ${
                                          isOverridden ? "border-primary" : "border-border"
                                        }`}
                                      />
                                      {isOverridden && (
                                        <button
                                          className="text-[10px] text-muted-foreground hover:text-primary underline"
                                          onClick={() => resetPriority(rt.id)}
                                        >
                                          reset
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">No runtimes</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
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
    </div>
  );
}
