import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  text,
  inputCls,
  textareaCls,
  type TabProps,
} from "../editor-helpers.js";
import type { WorldStartingConditions } from "@covel/shared";

export function StartingConditionsTab({ dimensions, onChange, t }: TabProps) {
  const sc: WorldStartingConditions = dimensions.startingConditions ?? {
    openingScenario: "",
  };

  function setSc(next: WorldStartingConditions) {
    onChange({ ...dimensions, startingConditions: next });
  }

  // Constraints
  function addConstraint() {
    setSc({
      ...sc,
      playerConstraints: [...(sc.playerConstraints ?? []), ""],
    });
  }

  function removeConstraint(index: number) {
    setSc({
      ...sc,
      playerConstraints: (sc.playerConstraints ?? []).filter(
        (_, i) => i !== index,
      ),
    });
  }

  function updateConstraint(index: number, value: string) {
    setSc({
      ...sc,
      playerConstraints: (sc.playerConstraints ?? []).map((c, i) =>
        i === index ? value : c,
      ),
    });
  }

  // Starting resources (key-value pairs)
  const resourceEntries = Object.entries(sc.startingResources ?? {});

  function addResourceEntry() {
    setSc({
      ...sc,
      startingResources: { ...sc.startingResources, "": 0 },
    });
  }

  function removeResourceEntry(key: string) {
    const next = { ...sc.startingResources };
    delete next[key];
    setSc({ ...sc, startingResources: next });
  }

  function updateResourceKey(oldKey: string, newKey: string) {
    const entries = Object.entries(sc.startingResources ?? {});
    const updated: Record<string, number> = {};
    for (const [k, v] of entries) {
      updated[k === oldKey ? newKey : k] = v;
    }
    setSc({ ...sc, startingResources: updated });
  }

  function updateResourceValue(key: string, value: number) {
    setSc({
      ...sc,
      startingResources: { ...sc.startingResources, [key]: value },
    });
  }

  return (
    <div className="space-y-6">
      {/* Opening Scenario */}
      <div className="space-y-1">
        <Label>{t("world.openingScenario")}</Label>
        <textarea
          className={textareaCls}
          value={text(sc.openingScenario)}
          onChange={(e) => setSc({ ...sc, openingScenario: e.target.value })}
        />
      </div>

      {/* Starting Location */}
      <div className="space-y-1">
        <Label>{t("world.startingLocation")}</Label>
        <input
          className={inputCls}
          value={text(sc.startingLocation)}
          onChange={(e) => setSc({ ...sc, startingLocation: e.target.value })}
        />
      </div>

      {/* Player Constraints */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.playerConstraints")}</Label>
          <Button variant="outline" size="sm" onClick={addConstraint}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addConstraint")}
          </Button>
        </div>
        {(sc.playerConstraints ?? []).map((c, ci) => (
          <div key={ci} className="flex items-center gap-2">
            <input
              className={inputCls}
              value={text(c)}
              onChange={(e) => updateConstraint(ci, e.target.value)}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeConstraint(ci)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Starting Resources (key-value) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.startingResources")}</Label>
          <Button variant="outline" size="sm" onClick={addResourceEntry}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addResource_kv")}
          </Button>
        </div>
        {resourceEntries.map(([key, value], ri) => (
          <div key={ri} className="flex items-center gap-2">
            <input
              className={inputCls}
              placeholder={t("world.key")}
              value={key}
              onChange={(e) => updateResourceKey(key, e.target.value)}
            />
            <input
              className="w-32 border border-border bg-background px-3 py-2 text-sm"
              type="number"
              placeholder={t("world.value")}
              value={value}
              onChange={(e) =>
                updateResourceValue(key, Number(e.target.value) || 0)
              }
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeResourceEntry(key)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
