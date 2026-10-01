import { useState } from "react";
import { worldDimensionsSchema, type WorldDimensions } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { useTranslation } from "react-i18next";

/** Author declarations, not session values. Validation is the same as world.yaml. */
export function DimensionsJsonEditor({
  dimensions,
  onChange,
}: {
  dimensions: WorldDimensions;
  onChange: (dimensions: WorldDimensions) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => JSON.stringify(dimensions, null, 2));
  const [error, setError] = useState<string | null>(null);
  function apply() {
    try {
      onChange(worldDimensionsSchema.parse(JSON.parse(draft)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <div className="space-y-3">
      <Label htmlFor="dimension-declarations">
        {t("world.dimensionDefinitions", "Dimension definitions (JSON)")}
      </Label>
      <textarea
        id="dimension-declarations"
        className="min-h-96 w-full rounded border bg-background p-3 font-mono text-xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="button" onClick={apply}>
        {t("world.applyDimensions", "Apply definitions")}
      </Button>
    </div>
  );
}
