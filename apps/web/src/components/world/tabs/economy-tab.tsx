import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { text, inputCls, textareaCls, type TabProps } from "../editor-helpers.js";
import type { WorldEconomy, WorldCurrency } from "@covel/shared";

export function EconomyTab({ dimensions, onChange, t }: TabProps) {
  const eco: WorldEconomy = dimensions.economy ?? { currencies: [] };

  function setEco(next: WorldEconomy) {
    onChange({ ...dimensions, economy: next });
  }

  function updateCurrency(index: number, patch: Partial<WorldCurrency>) {
    const currencies = eco.currencies.map((c, i) =>
      i === index ? { ...c, ...patch } : c,
    );
    setEco({ ...eco, currencies });
  }

  function addCurrency() {
    setEco({
      ...eco,
      currencies: [...eco.currencies, { name: "", symbol: "", description: "" }],
    });
  }

  function removeCurrency(index: number) {
    setEco({
      ...eco,
      currencies: eco.currencies.filter((_, i) => i !== index),
    });
  }

  function addResource() {
    setEco({ ...eco, resources: [...(eco.resources ?? []), ""] });
  }

  function removeResource(index: number) {
    setEco({
      ...eco,
      resources: (eco.resources ?? []).filter((_, i) => i !== index),
    });
  }

  function updateResource(index: number, value: string) {
    setEco({
      ...eco,
      resources: (eco.resources ?? []).map((r, i) =>
        i === index ? value : r,
      ),
    });
  }

  return (
    <div className="space-y-6">
      {/* Currencies */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.currencies")}</Label>
          <Button variant="outline" size="sm" onClick={addCurrency}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addCurrency")}
          </Button>
        </div>
        {eco.currencies.map((cur, ci) => (
          <div key={ci} className="border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {text(cur.name) || `${t("world.currencies")} #${ci + 1}`}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeCurrency(ci)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>{t("world.name")}</Label>
                <input
                  className={inputCls}
                  value={text(cur.name)}
                  onChange={(e) =>
                    updateCurrency(ci, { name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>{t("world.symbol")}</Label>
                <input
                  className={inputCls}
                  value={cur.symbol ?? ""}
                  onChange={(e) =>
                    updateCurrency(ci, { symbol: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>{t("world.description")}</Label>
                <input
                  className={inputCls}
                  value={text(cur.description)}
                  onChange={(e) =>
                    updateCurrency(ci, { description: e.target.value })
                  }
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Resources */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.resources")}</Label>
          <Button variant="outline" size="sm" onClick={addResource}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addResource")}
          </Button>
        </div>
        {(eco.resources ?? []).map((res, ri) => (
          <div key={ri} className="flex items-center gap-2">
            <input
              className={inputCls}
              value={text(res)}
              onChange={(e) => updateResource(ri, e.target.value)}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeResource(ri)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Trade Notes */}
      <div className="space-y-1">
        <Label>{t("world.tradeNotes")}</Label>
        <textarea
          className={textareaCls}
          value={text(eco.tradeNotes)}
          onChange={(e) => setEco({ ...eco, tradeNotes: e.target.value })}
        />
      </div>
    </div>
  );
}
