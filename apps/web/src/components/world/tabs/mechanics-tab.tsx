import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { text, textareaCls, selectCls, inputCls, type TabProps } from "../editor-helpers.js";
import type { WorldMechanics, CombatStyle, DifficultyLevel } from "@covel/shared";

const COMBAT_STYLES: CombatStyle[] = [
  "turn-based",
  "real-time",
  "narrative",
  "none",
];

const COMBAT_KEYS: Record<CombatStyle, string> = {
  "turn-based": "combatTurnBased",
  "real-time": "combatRealTime",
  narrative: "combatNarrative",
  none: "combatNone",
};

const DIFFICULTIES: DifficultyLevel[] = ["easy", "normal", "hard", "adaptive"];

const DIFFICULTY_KEYS: Record<DifficultyLevel, string> = {
  easy: "difficultyEasy",
  normal: "difficultyNormal",
  hard: "difficultyHard",
  adaptive: "difficultyAdaptive",
};

export function MechanicsTab({ dimensions, onChange, t }: TabProps) {
  const mech: WorldMechanics = dimensions.mechanics ?? {};

  function setMech(next: WorldMechanics) {
    onChange({ ...dimensions, mechanics: next });
  }

  function addCustomRule() {
    setMech({
      ...mech,
      customRules: [...(mech.customRules ?? []), ""],
    });
  }

  function removeCustomRule(index: number) {
    setMech({
      ...mech,
      customRules: (mech.customRules ?? []).filter((_, i) => i !== index),
    });
  }

  function updateCustomRule(index: number, value: string) {
    setMech({
      ...mech,
      customRules: (mech.customRules ?? []).map((r, i) =>
        i === index ? value : r,
      ),
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>{t("world.combatStyle")}</Label>
          <select
            className={selectCls}
            value={mech.combatStyle ?? "narrative"}
            onChange={(e) =>
              setMech({ ...mech, combatStyle: e.target.value as CombatStyle })
            }
          >
            {COMBAT_STYLES.map((cs) => (
              <option key={cs} value={cs}>
                {t(`world.${COMBAT_KEYS[cs]}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>{t("world.difficulty")}</Label>
          <select
            className={selectCls}
            value={mech.difficulty ?? "normal"}
            onChange={(e) =>
              setMech({
                ...mech,
                difficulty: e.target.value as DifficultyLevel,
              })
            }
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {t(`world.${DIFFICULTY_KEYS[d]}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <Label>{t("world.skillSystem")}</Label>
        <textarea
          className={textareaCls}
          value={text(mech.skillSystem)}
          onChange={(e) => setMech({ ...mech, skillSystem: e.target.value })}
        />
      </div>

      {/* Custom Rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.customRules")}</Label>
          <Button variant="outline" size="sm" onClick={addCustomRule}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addCustomRule")}
          </Button>
        </div>
        {(mech.customRules ?? []).map((rule, ri) => (
          <div key={ri} className="flex items-center gap-2">
            <input
              className={inputCls}
              value={text(rule)}
              onChange={(e) => updateCustomRule(ri, e.target.value)}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeCustomRule(ri)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
