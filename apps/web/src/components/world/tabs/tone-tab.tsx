import { Label } from "@/components/ui/label.js";
import {
  inputCls,
  textareaCls,
  selectCls,
  type TabProps,
} from "../editor-helpers.js";
import type { WorldTone, ContentRating } from "@covel/shared";

const CONTENT_RATINGS: ContentRating[] = ["all-ages", "teen", "mature"];

const RATING_KEYS: Record<ContentRating, string> = {
  "all-ages": "ratingAllAges",
  teen: "ratingTeen",
  mature: "ratingMature",
};

export function ToneTab({ dimensions, onChange, t }: TabProps) {
  const tone: WorldTone = dimensions.tone ?? {
    genres: [],
    contentRating: "teen",
  };

  function setTone(next: WorldTone) {
    onChange({ ...dimensions, tone: next });
  }

  return (
    <div className="space-y-6">
      {/* Genres (comma-separated) */}
      <div className="space-y-1">
        <Label htmlFor="world-tone-genres">{t("world.genres")}</Label>
        <input
          id="world-tone-genres"
          className={inputCls}
          value={tone.genres.join(", ")}
          onChange={(e) =>
            setTone({
              ...tone,
              genres: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>

      {/* Content Rating */}
      <div className="space-y-1">
        <Label htmlFor="world-tone-content-rating">
          {t("world.contentRating")}
        </Label>
        <select
          id="world-tone-content-rating"
          className={`${selectCls} w-full`}
          value={tone.contentRating}
          onChange={(e) =>
            setTone({
              ...tone,
              contentRating: e.target.value as ContentRating,
            })
          }
        >
          {CONTENT_RATINGS.map((cr) => (
            <option key={cr} value={cr}>
              {t(`world.${RATING_KEYS[cr]}`)}
            </option>
          ))}
        </select>
      </div>

      {/* Narrative Style */}
      <div className="space-y-1">
        <Label htmlFor="world-tone-narrative-style">
          {t("world.narrativeStyle")}
        </Label>
        <textarea
          id="world-tone-narrative-style"
          className={textareaCls}
          value={
            typeof tone.narrativeStyle === "string" ? tone.narrativeStyle : ""
          }
          onChange={(e) => setTone({ ...tone, narrativeStyle: e.target.value })}
        />
      </div>

      {/* Themes (comma-separated) */}
      <div className="space-y-1">
        <Label htmlFor="world-tone-themes">{t("world.themes")}</Label>
        <input
          id="world-tone-themes"
          className={inputCls}
          value={(tone.themes ?? []).join(", ")}
          onChange={(e) =>
            setTone({
              ...tone,
              themes: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </div>
  );
}
