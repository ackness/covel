import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  text,
  inputCls,
  textareaCls,
  type TabProps,
} from "../editor-helpers.js";
import type { WorldGeography, WorldRegion, WorldLandmark } from "@covel/shared";

export function GeographyTab({ dimensions, onChange, t }: TabProps) {
  const geo: WorldGeography = dimensions.geography ?? { regions: [] };

  function setGeo(next: WorldGeography) {
    onChange({ ...dimensions, geography: next });
  }

  function updateRegion(index: number, patch: Partial<WorldRegion>) {
    const regions = geo.regions.map((r, i) =>
      i === index ? { ...r, ...patch } : r,
    );
    setGeo({ ...geo, regions });
  }

  function addRegion() {
    setGeo({
      ...geo,
      regions: [
        ...geo.regions,
        { name: "", description: "", climate: "", landmarks: [] },
      ],
    });
  }

  function removeRegion(index: number) {
    setGeo({ ...geo, regions: geo.regions.filter((_, i) => i !== index) });
  }

  function addLandmark(regionIndex: number) {
    const region = geo.regions[regionIndex];
    const landmarks: WorldLandmark[] = [
      ...(region.landmarks ?? []),
      { name: "" },
    ];
    updateRegion(regionIndex, { landmarks });
  }

  function removeLandmark(regionIndex: number, lmIndex: number) {
    const region = geo.regions[regionIndex];
    const landmarks = (region.landmarks ?? []).filter((_, i) => i !== lmIndex);
    updateRegion(regionIndex, { landmarks });
  }

  function updateLandmark(
    regionIndex: number,
    lmIndex: number,
    patch: Partial<WorldLandmark>,
  ) {
    const region = geo.regions[regionIndex];
    const landmarks = (region.landmarks ?? []).map((lm, i) =>
      i === lmIndex ? { ...lm, ...patch } : lm,
    );
    updateRegion(regionIndex, { landmarks });
  }

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="space-y-2">
        <Label htmlFor="world-geography-overview">
          {t("world.geographyOverview")}
        </Label>
        <textarea
          id="world-geography-overview"
          className={textareaCls}
          value={text(geo.overview)}
          onChange={(e) => setGeo({ ...geo, overview: e.target.value })}
        />
      </div>

      {/* Regions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.regions")}</Label>
          <Button variant="outline" size="sm" onClick={addRegion}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addRegion")}
          </Button>
        </div>

        {geo.regions.map((region, ri) => (
          <div key={ri} className="border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {text(region.name) || `${t("world.regions")} #${ri + 1}`}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("world.remove")}
                onClick={() => removeRegion(ri)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`world-region-${ri}-name`}>
                  {t("world.name")}
                </Label>
                <input
                  id={`world-region-${ri}-name`}
                  className={inputCls}
                  value={text(region.name)}
                  onChange={(e) => updateRegion(ri, { name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`world-region-${ri}-climate`}>
                  {t("world.climate")}
                </Label>
                <input
                  id={`world-region-${ri}-climate`}
                  className={inputCls}
                  value={text(region.climate)}
                  onChange={(e) =>
                    updateRegion(ri, { climate: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`world-region-${ri}-description`}>
                {t("world.description")}
              </Label>
              <textarea
                id={`world-region-${ri}-description`}
                className={textareaCls}
                value={text(region.description)}
                onChange={(e) =>
                  updateRegion(ri, { description: e.target.value })
                }
              />
            </div>

            {/* Landmarks */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("world.landmarks")}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => addLandmark(ri)}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  {t("world.addLandmark")}
                </Button>
              </div>
              {(region.landmarks ?? []).map((lm, li) => (
                <div key={li} className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      aria-label={`${t("world.name")} ${li + 1}`}
                      className={inputCls}
                      placeholder={t("world.name")}
                      value={text(lm.name)}
                      onChange={(e) =>
                        updateLandmark(ri, li, { name: e.target.value })
                      }
                    />
                    <input
                      aria-label={`${t("world.description")} ${li + 1}`}
                      className={inputCls}
                      placeholder={t("world.description")}
                      value={text(lm.description)}
                      onChange={(e) =>
                        updateLandmark(ri, li, {
                          description: e.target.value,
                        })
                      }
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("world.remove")}
                    onClick={() => removeLandmark(ri, li)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
