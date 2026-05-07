import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  text,
  inputCls,
  textareaCls,
  type TabProps,
} from "../editor-helpers.js";
import type {
  WorldSocialStructure,
  SocialClass,
  WorldRace,
} from "@covel/shared";

export function SocialStructureTab({ dimensions, onChange, t }: TabProps) {
  const ss: WorldSocialStructure = dimensions.socialStructure ?? {};

  function setSs(next: WorldSocialStructure) {
    onChange({ ...dimensions, socialStructure: next });
  }

  // Classes
  function addClass() {
    setSs({
      ...ss,
      classes: [...(ss.classes ?? []), { name: "", description: "" }],
    });
  }

  function removeClass(index: number) {
    setSs({
      ...ss,
      classes: (ss.classes ?? []).filter((_, i) => i !== index),
    });
  }

  function updateClass(index: number, patch: Partial<SocialClass>) {
    setSs({
      ...ss,
      classes: (ss.classes ?? []).map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  }

  // Races
  function addRace() {
    setSs({
      ...ss,
      races: [...(ss.races ?? []), { name: "", description: "" }],
    });
  }

  function removeRace(index: number) {
    setSs({
      ...ss,
      races: (ss.races ?? []).filter((_, i) => i !== index),
    });
  }

  function updateRace(index: number, patch: Partial<WorldRace>) {
    setSs({
      ...ss,
      races: (ss.races ?? []).map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      ),
    });
  }

  return (
    <div className="space-y-6">
      {/* Classes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.classes")}</Label>
          <Button variant="outline" size="sm" onClick={addClass}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addClass")}
          </Button>
        </div>
        {(ss.classes ?? []).map((cls, ci) => (
          <div key={ci} className="flex items-start gap-2">
            <div className="flex-1 grid grid-cols-3 gap-2">
              <input
                className={inputCls}
                placeholder={t("world.name")}
                value={text(cls.name)}
                onChange={(e) => updateClass(ci, { name: e.target.value })}
              />
              <input
                className={inputCls}
                placeholder={t("world.description")}
                value={text(cls.description)}
                onChange={(e) =>
                  updateClass(ci, { description: e.target.value })
                }
              />
              <input
                className="w-24 border border-border bg-background px-3 py-2 text-sm"
                type="number"
                placeholder={t("world.rank")}
                value={cls.rank ?? ""}
                onChange={(e) =>
                  updateClass(ci, {
                    rank: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              />
            </div>
            <Button variant="ghost" size="icon" onClick={() => removeClass(ci)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Races */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.races")}</Label>
          <Button variant="outline" size="sm" onClick={addRace}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addRace")}
          </Button>
        </div>
        {(ss.races ?? []).map((race, ri) => (
          <div key={ri} className="flex items-center gap-2">
            <input
              className={inputCls}
              placeholder={t("world.name")}
              value={text(race.name)}
              onChange={(e) => updateRace(ri, { name: e.target.value })}
            />
            <input
              className={inputCls}
              placeholder={t("world.description")}
              value={text(race.description)}
              onChange={(e) => updateRace(ri, { description: e.target.value })}
            />
            <Button variant="ghost" size="icon" onClick={() => removeRace(ri)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Notes */}
      <div className="space-y-1">
        <Label>{t("world.notes")}</Label>
        <textarea
          className={textareaCls}
          value={text(ss.notes)}
          onChange={(e) => setSs({ ...ss, notes: e.target.value })}
        />
      </div>
    </div>
  );
}
