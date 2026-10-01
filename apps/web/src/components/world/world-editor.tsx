import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Braces,
  MapPin,
  Users,
  Zap,
  Clock,
  Coins,
  Building2,
  Palette,
  Gamepad2,
  Flag,
  Save,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { worldDimensionsSchema, type WorldDimensions } from "@covel/shared";
import {
  projectDimensionTemplates,
  dimensionTemplateSchemas,
  type DimensionsState,
} from "./editor-helpers.js";
import { DimensionsJsonEditor } from "./dimensions-json-editor.js";
import type { WorldRecord } from "@/services/api.js";
import { getDataService } from "@/services/data-service.js";
import { GeographyTab } from "./tabs/geography-tab.js";
import { FactionsTab } from "./tabs/factions-tab.js";
import { PowerSystemTab } from "./tabs/power-system-tab.js";
import { HistoryTab } from "./tabs/history-tab.js";
import { EconomyTab } from "./tabs/economy-tab.js";
import { SocialStructureTab } from "./tabs/social-structure-tab.js";
import { ToneTab } from "./tabs/tone-tab.js";
import { MechanicsTab } from "./tabs/mechanics-tab.js";
import { StartingConditionsTab } from "./tabs/starting-conditions-tab.js";

interface WorldEditorProps {
  world: WorldRecord;
  onSave: (updated: WorldRecord) => void;
  onCancel: () => void;
}

interface TabDef {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  {
    id: "definitions",
    labelKey: "world.dimensionDefinitions",
    icon: <Braces className="h-4 w-4" />,
  },
  {
    id: "geography",
    labelKey: "world.geography",
    icon: <MapPin className="h-4 w-4" />,
  },
  {
    id: "factions",
    labelKey: "world.factions",
    icon: <Users className="h-4 w-4" />,
  },
  {
    id: "powerSystem",
    labelKey: "world.powerSystem",
    icon: <Zap className="h-4 w-4" />,
  },
  {
    id: "history",
    labelKey: "world.history",
    icon: <Clock className="h-4 w-4" />,
  },
  {
    id: "economy",
    labelKey: "world.economy",
    icon: <Coins className="h-4 w-4" />,
  },
  {
    id: "socialStructure",
    labelKey: "world.socialStructure",
    icon: <Building2 className="h-4 w-4" />,
  },
  { id: "tone", labelKey: "world.tone", icon: <Palette className="h-4 w-4" /> },
  {
    id: "mechanics",
    labelKey: "world.mechanics",
    icon: <Gamepad2 className="h-4 w-4" />,
  },
  {
    id: "startingConditions",
    labelKey: "world.startingConditions",
    icon: <Flag className="h-4 w-4" />,
  },
];

export function WorldEditor({ world, onSave, onCancel }: WorldEditorProps) {
  const { t } = useTranslation();
  const [dimensions, setDimensions] = useState<WorldDimensions>(() =>
    structuredClone(world.dimensions ?? {}),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templateValues = projectDimensionTemplates(dimensions);
  function updateTemplates(next: DimensionsState) {
    try {
      setDimensions(
        worldDimensionsSchema.parse({
          ...dimensions,
          ...Object.fromEntries(
            Object.entries(next).map(([id, initialValue]) => [
              id,
              {
                ...(dimensions[id] ?? { name: t(`world.${id}`), schema: {} }),
                initialValue,
              },
            ]),
          ),
        }),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const templateComponents = {
    geography: GeographyTab,
    factions: FactionsTab,
    powerSystem: PowerSystemTab,
    history: HistoryTab,
    economy: EconomyTab,
    socialStructure: SocialStructureTab,
    tone: ToneTab,
    mechanics: MechanicsTab,
    startingConditions: StartingConditionsTab,
  };

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await getDataService().updateWorld(world.id, {
        dimensions,
      });
      onSave(updated);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t("world.saveFailed");
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-hidden bg-background p-3 sm:p-5 md:p-8">
      <Card className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden">
        <CardHeader className="sticky top-0 z-10 flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b border-border bg-card pb-4">
          <CardTitle>{t("world.dimensions")}</CardTitle>
          <div className="flex items-center gap-2">
            {error && <span className="text-sm text-destructive">{error}</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={saving}
            >
              <X className="mr-1 h-4 w-4" />
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="mr-1 h-4 w-4" />
              {saving ? t("common.loading") : t("common.save")}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 overflow-hidden pt-4">
          <Tabs defaultValue="definitions" className="flex flex-col h-full">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto overscroll-x-contain">
              {TABS.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  aria-label={t(tab.labelKey)}
                  className="shrink-0 gap-1.5"
                >
                  {tab.icon}
                  <span aria-hidden="true" className="hidden sm:inline">
                    {t(tab.labelKey)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {TABS.map((tab) => {
                const id = tab.id as keyof typeof templateComponents;
                const Component =
                  tab.id === "definitions" ? undefined : templateComponents[id];
                const compatible =
                  !dimensions[id] ||
                  dimensionTemplateSchemas[id]?.safeParse(
                    dimensions[id]?.initialValue,
                  ).success;
                return (
                  <TabsContent value={tab.id} key={tab.id}>
                    {Component && compatible ? (
                      <Component
                        dimensions={templateValues}
                        onChange={updateTemplates}
                        t={t}
                      />
                    ) : (
                      <DimensionsJsonEditor
                        dimensions={dimensions}
                        onChange={setDimensions}
                      />
                    )}
                  </TabsContent>
                );
              })}
            </div>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
