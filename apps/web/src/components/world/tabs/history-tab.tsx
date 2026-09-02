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
import type { WorldHistoryEvent, HistorySignificance } from "@covel/shared";

const SIGNIFICANCE_LEVELS: HistorySignificance[] = ["major", "minor"];

export function HistoryTab({ dimensions, onChange, t }: TabProps) {
  const events: WorldHistoryEvent[] = [...(dimensions.history ?? [])];

  function setEvents(next: WorldHistoryEvent[]) {
    onChange({ ...dimensions, history: next });
  }

  function updateEvent(index: number, patch: Partial<WorldHistoryEvent>) {
    setEvents(events.map((ev, i) => (i === index ? { ...ev, ...patch } : ev)));
  }

  function addEvent() {
    setEvents([
      ...events,
      { name: "", description: "", significance: "minor" },
    ]);
  }

  function removeEvent(index: number) {
    setEvents(events.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>{t("world.history")}</Label>
        <Button variant="outline" size="sm" onClick={addEvent}>
          <Plus className="mr-1 h-4 w-4" />
          {t("world.addEvent")}
        </Button>
      </div>

      {events.map((ev, ei) => (
        <div key={ei} className="border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {text(ev.name) || `${t("world.history")} #${ei + 1}`}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("world.remove")}
              onClick={() => removeEvent(ei)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor={`world-history-${ei}-era`}>
                {t("world.era")}
              </Label>
              <input
                id={`world-history-${ei}-era`}
                className={inputCls}
                value={text(ev.era)}
                onChange={(e) => updateEvent(ei, { era: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`world-history-${ei}-year`}>
                {t("world.year")}
              </Label>
              <input
                id={`world-history-${ei}-year`}
                className={inputCls}
                value={text(ev.year)}
                onChange={(e) => updateEvent(ei, { year: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`world-history-${ei}-name`}>
                {t("world.name")}
              </Label>
              <input
                id={`world-history-${ei}-name`}
                className={inputCls}
                value={text(ev.name)}
                onChange={(e) => updateEvent(ei, { name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`world-history-${ei}-significance`}>
                {t("world.significance")}
              </Label>
              <select
                id={`world-history-${ei}-significance`}
                className={`${selectCls} w-full`}
                value={ev.significance}
                onChange={(e) =>
                  updateEvent(ei, {
                    significance: e.target.value as HistorySignificance,
                  })
                }
              >
                {SIGNIFICANCE_LEVELS.map((s) => (
                  <option key={s} value={s}>
                    {t(`world.significance${s[0].toUpperCase()}${s.slice(1)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`world-history-${ei}-description`}>
              {t("world.description")}
            </Label>
            <textarea
              id={`world-history-${ei}-description`}
              className={textareaCls}
              value={text(ev.description)}
              onChange={(e) => updateEvent(ei, { description: e.target.value })}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
