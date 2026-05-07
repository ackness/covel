import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
import { ScrollArea } from "@/components/ui/scroll-area.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import type { WorldDimensions } from "@covel/shared";
import type { WorldRecord } from "@/services/api.js";
import * as api from "@/services/api.js";
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

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateWorld(world.id, { dimensions });
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
    <Card className="flex flex-col h-full">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-4">
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

      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="geography" className="flex flex-col h-full">
          <TabsList className="flex flex-wrap h-auto gap-1">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
                {tab.icon}
                <span className="hidden sm:inline">{t(tab.labelKey)}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <ScrollArea className="flex-1 mt-4">
            <TabsContent value="geography">
              <GeographyTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="factions">
              <FactionsTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="powerSystem">
              <PowerSystemTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="history">
              <HistoryTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="economy">
              <EconomyTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="socialStructure">
              <SocialStructureTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="tone">
              <ToneTab dimensions={dimensions} onChange={setDimensions} t={t} />
            </TabsContent>
            <TabsContent value="mechanics">
              <MechanicsTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
            <TabsContent value="startingConditions">
              <StartingConditionsTab
                dimensions={dimensions}
                onChange={setDimensions}
                t={t}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </CardContent>
    </Card>
  );
}
