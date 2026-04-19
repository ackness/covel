import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Sparkles, Loader2, KeyRound, Cpu, Eye, Wand2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { WorldDetailView } from "@/components/world/world-detail-view.js";
import { WorldEditor } from "@/components/world/world-editor.js";
import { AiWorldGenerator } from "@/components/world/ai-world-generator.js";
import type { WorldRecord, PackageSummary } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

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
}: WorldSelectScreenProps) {
  const { t } = useTranslation();
  const primarySlot = resolvedSlots[0] ?? null;
  const primarySlotLabel = primarySlot
    ? primarySlot.preset
      ? `${primarySlot.preset.name} (${primarySlot.preset.model})`
      : primarySlot.serverModel
        ? `${primarySlot.slotId} (${primarySlot.serverModel})`
        : null
    : null;

  const [mode, setMode] = useState<ViewMode>("list");
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);

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

  // ── Detail / Edit view ───────────────────────────────────
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

  // ── World list ───────────────────────────────────────────
  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} />
      <AiWorldGenerator
        open={generatorOpen}
        onOpenChange={setGeneratorOpen}
        onWorldCreated={(world) => onWorldCreated?.(world)}
      />
      <ScrollArea className="w-full h-full">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-16">
          <div className="mb-4">
            <SessionBreadcrumb step="world_select" />
          </div>

          <div className="text-center mb-10 space-y-3">
            <h1 className="font-display font-bold text-2xl md:text-3xl uppercase tracking-widest flex items-center justify-center gap-3">
              <Globe className="w-6 h-6 md:w-8 md:h-8" />
              {t("session.selectWorld", "Select World")}
            </h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {t("session.worldSelectDesc")}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button variant="ghost" size="sm" className="text-xs uppercase tracking-widest" onClick={() => onSettingsOpenChange(true)}>
                <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                {t("session.configureKeys")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs uppercase tracking-widest"
                onClick={() => setGeneratorOpen(true)}
              >
                <Wand2 className="w-3.5 h-3.5 mr-1.5" />
                {t("world.aiCreate")}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:gap-6">
            {worlds.map((world) => (
              <Card
                key={world.id}
                className="cursor-pointer transition-all hover:border-primary/50 hover:shadow-md group"
                onClick={() => onSelectWorld(world.id)}
              >
                <CardContent className="p-5 md:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <h2 className="font-display font-bold text-lg group-hover:text-primary transition-colors">
                        {text(world.name)}
                      </h2>
                      <p className="text-sm text-muted-foreground">{text(world.description)}</p>
                      {world.tags && world.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {world.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 mt-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => handleViewDetails(e, world.id)}
                        title={t("world.viewDetails")}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Sparkles className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {worlds.length === 0 && (
            <div className="text-center py-12">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-2">{t("session.loadingWorlds")}</p>
            </div>
          )}

          {/* Footer info */}
          <div className="mt-10 pt-6 border-t border-border flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
            {packages.filter((p) => p.enabled).length > 0 && (
              <span className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" />
                {t("session.pluginsLoaded", { count: packages.filter((p) => p.enabled).length })}
              </span>
            )}
            {primarySlotLabel && (
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                {primarySlotLabel}
              </span>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
