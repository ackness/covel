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
  settingsInitialKey?: string;
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
  settingsInitialKey,
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
    ? (worlds.find((w) => w.id === selectedWorldId) ?? null)
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

  const deletingWorld = deletingWorldId
    ? worlds.find((w) => w.id === deletingWorldId)
    : null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("world.deleteConfirmTitle", "Delete world?")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "world.deleteConfirmDesc",
                'This will permanently delete "{{name}}". This action cannot be undone.',
                {
                  name: deletingWorld
                    ? text(deletingWorld.name)
                    : deletingWorldId,
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteConfirmOpen(false)}
            >
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
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={onSettingsOpenChange}
        initialKey={settingsInitialKey}
      />
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
                {t(
                  "session.worldsHeaderEyebrow",
                  `${worlds.length} worlds available`,
                  {
                    count: worlds.length,
                  },
                )}
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
                      {primarySlotLabel ??
                        t("session.noModelsConfigured", "No model configured")}
                    </p>
                  </div>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
              </button>
            </aside>
          </header>

          {/* World list — editorial plate layout. No gradient hero, no card.
              Each world is a numbered plate with a thin top rule, hover
              shifts the title via the marker color. */}
          {worlds.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-0">
              {worlds.map((world, index) => {
                const isEntering = enteringWorldId === world.id;
                const dimmed = enteringWorldId !== null && !isEntering;
                const accentHue = hashIndex(world.id, CARD_GRADIENTS.length);
                const accentColors = [
                  "var(--accent-primary)",
                  "var(--accent-secondary)",
                  "var(--accent-warning)",
                  "var(--accent-success)",
                  "var(--accent-primary)",
                ];
                const markerColor = accentColors[accentHue];
                return (
                  <article
                    key={world.id}
                    aria-busy={isEntering}
                    onClick={() => handleEnterWorld(world.id)}
                    className={`group relative cursor-pointer py-7 transition-opacity ${
                      isEntering ? "opacity-100" : ""
                    } ${dimmed ? "opacity-30 pointer-events-none" : ""}`}
                    style={{
                      borderTop: "1px solid var(--rule-strong-color)",
                    }}
                  >
                    {/* Plate number — top right */}
                    <div className="absolute top-2 right-0 ui-meta text-[10px] text-muted-foreground/70 tabular-nums">
                      № {String(index + 1).padStart(2, "0")} · {world.id}
                    </div>

                    {/* Marker dot — colored hairline above title */}
                    <div
                      aria-hidden
                      className="absolute -top-px left-0 h-0.5 w-12 transition-all group-hover:w-24"
                      style={{ background: markerColor }}
                    />

                    <div className="space-y-3 mt-1.5 pr-4">
                      <h2
                        className="ui-title text-2xl md:text-3xl leading-[1.1] tracking-tight transition-colors"
                        style={isEntering ? { color: markerColor } : undefined}
                      >
                        {text(world.name)}
                      </h2>
                      <p className="text-[14px] text-muted-foreground leading-relaxed line-clamp-3 break-words [overflow-wrap:anywhere] max-w-prose">
                        {text(world.description)}
                      </p>

                      <div className="flex items-center justify-between gap-3 pt-1">
                        <div className="flex flex-wrap gap-1.5 min-w-0">
                          {(world.tags ?? []).slice(0, 4).map((tag) => (
                            <span key={tag} className="ui-tag">
                              {tag}
                            </span>
                          ))}
                          {(world.tags?.length ?? 0) > 4 && (
                            <span className="ui-meta text-[10px] text-muted-foreground/70 self-center">
                              +{(world.tags?.length ?? 0) - 4}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => handleViewDetails(e, world.id)}
                            aria-label={t("world.viewDetails", "View details")}
                            className="ui-btn ui-btn-quiet text-muted-foreground hover:text-foreground h-7 w-7 p-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {world.metadata?.source !== "file" && (
                            <button
                              type="button"
                              onClick={(e) => handleDeleteClick(e, world.id)}
                              aria-label={t("world.delete", "Delete world")}
                              className="ui-btn ui-btn-quiet text-muted-foreground hover:text-[var(--accent-danger)] h-7 w-7 p-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span
                            className="ui-meta inline-flex items-center gap-1 ml-2 transition-all group-hover:gap-2"
                            style={{ color: markerColor }}
                          >
                            {t("session.enter", "Enter")}
                            <ArrowRight className="w-3 h-3" />
                          </span>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {worlds.length === 0 && (
            <div className="text-center py-16 md:py-24 border-y border-dashed border-[var(--rule-color)]">
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
