import { useTranslation } from "react-i18next";
import { Globe, Sparkles, Loader2, KeyRound, Cpu } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import type { WorldRecord, PackageSummary, PresetSummary } from "@/services/api.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

interface WorldSelectScreenProps {
  worlds: WorldRecord[];
  packages: PackageSummary[];
  resolvedSlots: ResolvedSlot[];
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  onSelectWorld: (worldId: string) => void;
}

export function WorldSelectScreen({
  worlds,
  packages,
  resolvedSlots,
  settingsOpen,
  onSettingsOpenChange,
  onSelectWorld,
}: WorldSelectScreenProps) {
  const { t } = useTranslation();
  const defaultSlot = resolvedSlots.find((s) => s.slotId === "default");

  return (
    <div className="flex h-full w-full overflow-hidden">
      <SettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} />
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
              Choose a world to begin your adventure. Each world has unique lore, characters, and narration style.
            </p>
            <Button variant="ghost" size="sm" className="text-xs uppercase tracking-widest" onClick={() => onSettingsOpenChange(true)}>
              <KeyRound className="w-3.5 h-3.5 mr-1.5" />
              Configure API Keys
            </Button>
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
                        {world.name}
                      </h2>
                      <p className="text-sm text-muted-foreground">{world.description}</p>
                      {world.tags && world.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {world.tags.map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <Sparkles className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {worlds.length === 0 && (
            <div className="text-center py-12">
              <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-2">Loading worlds...</p>
            </div>
          )}

          {/* Footer info */}
          <div className="mt-10 pt-6 border-t border-border flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
            {packages.filter((p) => p.enabled).length > 0 && (
              <span className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" />
                {packages.filter((p) => p.enabled).length} plugins loaded
              </span>
            )}
            {defaultSlot?.preset && (
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                {defaultSlot.preset.name} ({defaultSlot.preset.model})
              </span>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
