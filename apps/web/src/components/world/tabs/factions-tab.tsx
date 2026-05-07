import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  text,
  inputCls,
  textareaCls,
  selectCls,
  type TabProps,
} from "../editor-helpers.js";
import type { WorldFaction, FactionType, InfluenceLevel } from "@covel/shared";

const FACTION_TYPES: FactionType[] = [
  "political",
  "guild",
  "corporate",
  "religious",
  "criminal",
  "military",
  "other",
];

const INFLUENCE_LEVELS: InfluenceLevel[] = ["major", "minor"];

let factionCounter = 0;

export function FactionsTab({ dimensions, onChange, t }: TabProps) {
  const factions: WorldFaction[] = [...(dimensions.factions ?? [])];

  function setFactions(next: WorldFaction[]) {
    onChange({ ...dimensions, factions: next });
  }

  function updateFaction(index: number, patch: Partial<WorldFaction>) {
    setFactions(factions.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function addFaction() {
    factionCounter += 1;
    setFactions([
      ...factions,
      {
        id: `faction-${Date.now()}-${factionCounter}`,
        name: "",
        description: "",
        type: "other",
        influence: "minor",
      },
    ]);
  }

  function removeFaction(index: number) {
    setFactions(factions.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>{t("world.factions")}</Label>
        <Button variant="outline" size="sm" onClick={addFaction}>
          <Plus className="mr-1 h-4 w-4" />
          {t("world.addFaction")}
        </Button>
      </div>

      {factions.map((faction, fi) => (
        <div key={faction.id} className="border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {text(faction.name) || `${t("world.factions")} #${fi + 1}`}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeFaction(fi)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("world.name")}</Label>
              <input
                className={inputCls}
                value={text(faction.name)}
                onChange={(e) => updateFaction(fi, { name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("world.factionType")}</Label>
              <select
                className={selectCls}
                value={faction.type}
                onChange={(e) =>
                  updateFaction(fi, { type: e.target.value as FactionType })
                }
              >
                {FACTION_TYPES.map((ft) => (
                  <option key={ft} value={ft}>
                    {t(`world.factionType${ft[0].toUpperCase()}${ft.slice(1)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>{t("world.description")}</Label>
            <textarea
              className={textareaCls}
              value={text(faction.description)}
              onChange={(e) =>
                updateFaction(fi, { description: e.target.value })
              }
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>{t("world.influence")}</Label>
              <select
                className={selectCls}
                value={faction.influence}
                onChange={(e) =>
                  updateFaction(fi, {
                    influence: e.target.value as InfluenceLevel,
                  })
                }
              >
                {INFLUENCE_LEVELS.map((il) => (
                  <option key={il} value={il}>
                    {t(`world.influence${il[0].toUpperCase()}${il.slice(1)}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>{t("world.leader")}</Label>
              <input
                className={inputCls}
                value={text(faction.leader)}
                onChange={(e) => updateFaction(fi, { leader: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("world.headquarters")}</Label>
              <input
                className={inputCls}
                value={text(faction.headquarters)}
                onChange={(e) =>
                  updateFaction(fi, { headquarters: e.target.value })
                }
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
