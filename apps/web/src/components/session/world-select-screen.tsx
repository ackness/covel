import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  KeyRound,
  Cpu,
  Eye,
  Trash2,
  Wand2,
  FolderOpen,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";
import { WorldDetailView } from "@/components/world/world-detail-view.js";
import { WorldEditor } from "@/components/world/world-editor.js";
import { AiWorldGenerator } from "@/components/world/ai-world-generator.js";
import * as api from "@/services/api.js";
import type { WorldRecord, PackageSummary } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { formatSlotLabel, type ResolvedSlot } from "@/hooks/use-slot-config.js";

type ViewMode = "list" | "detail" | "edit";

interface WorldSelectScreenProps {
  worlds: WorldRecord[];
  packages: PackageSummary[];
  resolvedSlots: ResolvedSlot[];
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  onSelectWorld: (worldId: string) => void;
  onWorldUpdated?: (world: WorldRecord) => void;
  onWorldCreated?: (world: WorldRecord) => void;
  onWorldDeleted?: (worldId: string) => void;
}

// Cycle through a small palette to give each card a distinctive but on-brand
// gradient cap. Hashed by world id so each world keeps its colour.
const CARD_GRADIENTS = [
  "linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 65%, transparent), color-mix(in oklab, oklch(70% 0.18 280) 55%, transparent))",
  "linear-gradient(135deg, color-mix(in oklab, oklch(72% 0.16 200) 65%, transparent), color-mix(in oklab, var(--color-primary) 50%, transparent))",
  "linear-gradient(135deg, color-mix(in oklab, oklch(70% 0.18 25) 60%, transparent), color-mix(in oklab, oklch(60% 0.20 320) 55%, transparent))",
  "linear-gradient(135deg, color-mix(in oklab, oklch(75% 0.15 130) 55%, transparent), color-mix(in oklab, oklch(60% 0.18 240) 55%, transparent))",
  "linear-gradient(135deg, color-mix(in oklab, oklch(68% 0.20 60) 55%, transparent), color-mix(in oklab, oklch(60% 0.18 350) 55%, transparent))",
];

function hashIndex(id: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % mod;
}

export function WorldSelectScreen({
  worlds,
  packages,
  resolvedSlots,
  settingsOpen,
  onSettingsOpenChange,
  onSelectWorld,
  onWorldUpdated,
  onWorldCreated,
  onWorldDeleted,
}: WorldSelectScreenProps) {
  const { t } = useTranslation();
  const primarySlotLabel = formatSlotLabel(resolvedSlots[0]);
  const enabledPluginCount = packages.filter((p) => p.enabled).length;

  const [mode, setMode] = useState<ViewMode>("list");
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [enteringWorldId, setEnteringWorldId] = useState<string | null>(null);
  const [deletingWorldId, setDeletingWorldId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleEnterWorld(worldId: string) {
    if (enteringWorldId) return;
    setEnteringWorldId(worldId);
    window.requestAnimationFrame(() => {
      onSelectWorld(worldId);
    });
  }

  const selectedWorld = selectedWorldId
    ? worlds.find((w) => w.id === selectedWorldId) ?? null
    : null;

  function handleViewDetails(e: React.MouseEvent, worldId: string) {
    e.stopPropagation();
    setSelectedWorldId(worldId);
    setMode("detail");
  }

  function handleBack() {
    setMode("list");
    setSelectedWorldId(null);
  }

  function handleEditFromDetail() {
    setMode("edit");
  }

  function handleSave(updated: WorldRecord) {
    onWorldUpdated?.(updated);
    setMode("detail");
  }

  function handleDeleteClick(e: React.MouseEvent, worldId: string) {
    e.stopPropagation();
    setDeletingWorldId(worldId);
    setDeleteConfirmOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!deletingWorldId) return;
    try {
      await api.deleteWorld(deletingWorldId);
      onWorldDeleted?.(deletingWorldId);
    } catch {
      // toast already shown by api request handler
    } finally {
      setDeletingWorldId(null);
      setDeleteConfirmOpen(false);
    }
  }

  if (mode === "detail" && selectedWorld) {
    return (
      <WorldDetailView
        world={selectedWorld}
        onClose={handleBack}
        onEdit={handleEditFromDetail}
      />
    );
  }

  if (mode === "edit" && selectedWorld) {
    return (
      <WorldEditor
        world={selectedWorld}
        onSave={handleSave}
        onCancel={() => setMode("detail")}
      />
    );
  }

  const deletingWorld = deletingWorldId ? worlds.find((w) => w.id === deletingWorldId) : null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("world.deleteConfirmTitle", "Delete world?")}
            </DialogTitle>
            <DialogDescription>
              {t("world.deleteConfirmDesc", 'This will permanently delete "{{name}}". This action cannot be undone.', {
                name: deletingWorld ? text(deletingWorld.name) : deletingWorldId,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDeleteConfirm}
            >
              {t("world.deleteConfirmAction", "Delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <SettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} />
      <AiWorldGenerator
        open={generatorOpen}
        onOpenChange={setGeneratorOpen}
        onWorldCreated={(world) => onWorldCreated?.(world)}
      />
      <ScrollArea className="w-full h-full">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-6 md:py-12">
          {/* Editorial header */}
          <header className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10 items-end mb-12 md:mb-16">
            <div className="md:col-span-7">
              <p className="ui-eyebrow text-muted-foreground mb-3">
                {t("session.worldsHeaderEyebrow", `${worlds.length} worlds available`, {
                  count: worlds.length,
                })}
              </p>
              <h1 className="font-display font-bold tracking-tight leading-[0.95] text-[clamp(2.25rem,6vw,4.5rem)]">
                {t("session.selectWorld", "Choose a world")}
              </h1>
              <p className="mt-5 text-sm md:text-base text-muted-foreground font-light leading-relaxed max-w-xl">
                {t(
                  "session.worldSelectDesc",
                  "Each world is a self-contained setting with its own tone, characters, and ruleset.",
                )}
              </p>
            </div>

            {/* Right-side action card — promotes AI generate, secondary key config */}
            <aside className="md:col-span-5 grid grid-cols-1 gap-2.5">
              <button
                type="button"
                onClick={() => setGeneratorOpen(true)}
                className="group relative overflow-hidden rounded-[var(--radius-card)] border border-primary/30 bg-card hover:border-primary/60 transition-all p-5 text-left"
              >
                <div
                  aria-hidden="true"
                  className="absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-50 group-hover:opacity-80 transition-opacity"
                  style={{
                    background:
                      "radial-gradient(circle, color-mix(in oklab, var(--color-primary) 70%, transparent) 0%, transparent 70%)",
                  }}
                />
                <div className="relative">
                  <div className="flex items-center gap-2 mb-2">
                    <Wand2 className="w-4 h-4 text-primary" />
                    <span className="ui-eyebrow text-primary">
                      {t("world.aiCreate", "AI generate")}
                    </span>
                  </div>
                  <p className="font-display text-base font-semibold leading-snug">
                    {t(
                      "session.aiCreateTeaser",
                      "Spin up a brand new world from a one-line idea.",
                    )}
                  </p>
                  <p className="mt-3 text-xs text-primary inline-flex items-center gap-1.5 group-hover:gap-2.5 transition-all font-medium">
                    {t("session.aiCreateAction", "Describe your idea")}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => onSettingsOpenChange(true)}
                className="group flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-card hover:border-primary/40 hover:bg-muted/30 transition-all p-4 text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {t("session.configureKeys", "API keys & presets")}
                    </p>
                    <p className="text-[11px] text-muted-foreground/80 truncate">
                      {primarySlotLabel ?? t("session.noModelsConfigured", "No model configured")}
                    </p>
                  </div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
              </button>
            </aside>
          </header>

          {/* World grid */}
          {worlds.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5">
              {worlds.map((world) => {
                const isEntering = enteringWorldId === world.id;
                const dimmed = enteringWorldId !== null && !isEntering;
                const gradient = CARD_GRADIENTS[hashIndex(world.id, CARD_GRADIENTS.length)];
                return (
                  <article
                    key={world.id}
                    aria-busy={isEntering}
                    onClick={() => handleEnterWorld(world.id)}
                    className={`group relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-card cursor-pointer transition-all duration-300 hover:border-primary/50 hover:-translate-y-0.5 ${
                      isEntering ? "border-primary -translate-y-0.5" : ""
                    } ${dimmed ? "opacity-40 pointer-events-none" : ""}`}
                  >
                    {/* Gradient hero strip */}
                    <div
                      aria-hidden="true"
                      className="relative h-28 md:h-32 overflow-hidden"
                      style={{ background: gradient }}
                    >
                      <div
                        className="absolute inset-0"
                        style={{
                          background:
                            "radial-gradient(circle at 25% 30%, color-mix(in oklab, var(--surface-app) 35%, transparent) 0%, transparent 60%)",
                        }}
                      />
                      <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-3">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/80 bg-background/40 backdrop-blur-sm px-2 py-1 rounded">
                          {world.id}
                        </span>
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => handleViewDetails(e, world.id)}
                            aria-label={t("world.viewDetails", "View details")}
                            className="h-7 w-7 inline-flex items-center justify-center rounded bg-background/60 backdrop-blur-sm hover:bg-background text-foreground"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {world.metadata?.source !== 'file' && (
                            <button
                              type="button"
                              onClick={(e) => handleDeleteClick(e, world.id)}
                              aria-label={t("world.delete", "Delete world")}
                              className="h-7 w-7 inline-flex items-center justify-center rounded bg-background/60 backdrop-blur-sm hover:bg-destructive hover:text-destructive-foreground text-foreground"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="p-5 md:p-6 space-y-3">
                      <h2 className="font-display font-bold text-lg md:text-xl leading-tight group-hover:text-primary transition-colors">
                        {text(world.name)}
                      </h2>
                      <p className="text-sm text-muted-foreground font-light leading-relaxed line-clamp-3 break-words [overflow-wrap:anywhere]">
                        {text(world.description)}
                      </p>
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <div className="flex flex-wrap gap-1.5 min-w-0">
                          {(world.tags ?? []).slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground border border-border/80 rounded-full"
                            >
                              {tag}
                            </span>
                          ))}
                          {(world.tags?.length ?? 0) > 3 && (
                            <span className="text-[10px] text-muted-foreground/60">
                              +{(world.tags?.length ?? 0) - 3}
                            </span>
                          )}
                        </div>
                        <span className="ui-eyebrow text-primary inline-flex items-center gap-1 shrink-0 group-hover:gap-2 transition-all">
                          {t("session.enter", "Enter")}
                          <ArrowRight className="w-3 h-3" />
                        </span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {worlds.length === 0 && (
            <div className="text-center py-16 md:py-24 border border-dashed border-border rounded-[var(--radius-card)] bg-card/30">
              <FolderOpen className="w-10 h-10 mx-auto text-muted-foreground/60" />
              <h2 className="font-display font-bold text-xl mt-5">
                {t("session.worldsEmptyTitle", "No worlds yet")}
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto font-light">
                {t(
                  "session.worldsEmptyDesc",
                  "Generate a new world with AI, or add a world package under the worlds/ folder.",
                )}
              </p>
              <div className="flex items-center justify-center gap-3 mt-7">
                <Button
                  size="sm"
                  className="text-xs uppercase tracking-widest"
                  onClick={() => setGeneratorOpen(true)}
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1.5" />
                  {t("world.aiCreate", "AI create")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs uppercase tracking-widest"
                  onClick={() =>
                    window.open(
                      "https://github.com/ackness/covel/tree/main/worlds",
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  {t("session.worldsEmptyViewExamples", "View examples")}
                </Button>
              </div>
            </div>
          )}

          {/* Footer info chips */}
          <div className="mt-12 md:mt-16 pt-6 border-t border-border flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {enabledPluginCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="w-3 h-3" />
                {t("session.pluginsLoaded", { count: enabledPluginCount })}
              </span>
            )}
            {primarySlotLabel && (
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" />
                {primarySlotLabel}
              </span>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
