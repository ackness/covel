import { useState, type CSSProperties } from "react";
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
import { worldVisual } from "@/lib/world-visuals.js";

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

export function worldStorageLabel(world: WorldRecord): string {
  const metadata = world.metadata;
  const storage = metadata?.storage as
    | {
        scope?: string;
        backend?: string;
      }
    | undefined;
  if (storage?.scope === "browser" && storage.backend === "indexeddb") {
    return "Browser IndexedDB";
  }
  if (storage?.scope === "server" && storage.backend === "file") {
    return "Server file";
  }
  if (storage?.scope === "server" && storage.backend) {
    return `Server ${storage.backend}`;
  }
  if (metadata?.source === "file") return "Built-in";
  if (metadata?.source === "browser-indexeddb") return "Browser IndexedDB";
  if (metadata?.source === "server-store") return "Server store";
  return "Server";
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

          {/* World list — cover-led plates with the same action surface. */}
          {worlds.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 md:gap-6">
              {worlds.map((world, index) => {
                const isEntering = enteringWorldId === world.id;
                const dimmed = enteringWorldId !== null && !isEntering;
                const visual = worldVisual(world);
                return (
                  <article
                    key={world.id}
                    aria-busy={isEntering}
                    onClick={() => handleEnterWorld(world.id)}
                    className={`group relative min-h-[360px] cursor-pointer overflow-hidden rounded-[var(--radius-card)] border border-border bg-card transition-all hover:border-primary/40 ${
                      isEntering ? "opacity-100" : ""
                    } ${dimmed ? "opacity-30 pointer-events-none" : ""}`}
                    style={
                      {
                        "--world-accent": visual.accent,
                        boxShadow: isEntering
                          ? "0 24px 80px -50px var(--world-accent)"
                          : undefined,
                      } as CSSProperties
                    }
                  >
                    <img
                      src={visual.image}
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"
                      draggable={false}
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-0"
                      style={{
                        background:
                          "linear-gradient(180deg, rgba(0,0,0,.08) 0%, rgba(0,0,0,.42) 46%, rgba(0,0,0,.78) 100%)",
                      }}
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 opacity-75"
                      style={{
                        background:
                          "linear-gradient(90deg, rgba(0,0,0,.62) 0%, rgba(0,0,0,.24) 58%, rgba(0,0,0,.18) 100%)",
                      }}
                    />
                    <div
                      aria-hidden
                      className="absolute left-0 top-0 h-1 w-24 transition-all group-hover:w-40"
                      style={{ background: "var(--world-accent)" }}
                    />

                    <div className="relative z-10 flex min-h-[360px] flex-col justify-between p-5 md:p-6 text-white">
                      <div className="flex items-start justify-between gap-4">
                        <span className="ui-meta text-[10px] text-white/62 tabular-nums">
                          № {String(index + 1).padStart(2, "0")} · {world.id}
                        </span>
                        <span
                          className="ui-tag border-white/18 bg-black/18 text-white/70 backdrop-blur-sm"
                          title="World storage"
                        >
                          {worldStorageLabel(world)}
                        </span>
                      </div>

                      <div className="space-y-4">
                        <div className="max-w-[31rem] space-y-3">
                          <h2
                            className="ui-title text-3xl md:text-4xl leading-[1.02] tracking-tight text-white transition-colors"
                            style={
                              isEntering
                                ? { color: "var(--world-accent)" }
                                : undefined
                            }
                          >
                            {text(world.name)}
                          </h2>
                          <p className="text-[14px] leading-relaxed text-white/76 line-clamp-3 break-words [overflow-wrap:anywhere]">
                            {text(world.description)}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {(world.tags ?? []).slice(0, 5).map((tag) => (
                            <span
                              key={tag}
                              className="ui-tag border-white/16 bg-black/20 text-white/62 backdrop-blur-sm"
                            >
                              {tag}
                            </span>
                          ))}
                          {(world.tags?.length ?? 0) > 5 && (
                            <span className="ui-meta text-[10px] text-white/54 self-center">
                              +{(world.tags?.length ?? 0) - 5}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center justify-between gap-3 border-t border-white/14 pt-4">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => handleViewDetails(e, world.id)}
                              aria-label={t(
                                "world.viewDetails",
                                "View details",
                              )}
                              className="ui-btn ui-btn-quiet h-8 w-8 border-white/12 bg-black/12 p-0 text-white/72 hover:bg-white/10 hover:text-white"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            {world.metadata?.source !== "file" && (
                              <button
                                type="button"
                                onClick={(e) => handleDeleteClick(e, world.id)}
                                aria-label={t("world.delete", "Delete world")}
                                className="ui-btn ui-btn-quiet h-8 w-8 border-white/12 bg-black/12 p-0 text-white/72 hover:text-[var(--accent-danger)]"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                          <span
                            className="ui-meta inline-flex items-center gap-1.5 transition-all group-hover:gap-2.5"
                            style={{ color: "var(--world-accent)" }}
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
