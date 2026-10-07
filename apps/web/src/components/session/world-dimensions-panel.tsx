import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  validateDimensionValue,
  type DimensionSnapshot,
  type JsonValue,
  type DimensionSettlementSummary,
} from "@covel/shared";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";
import { Button } from "@/components/ui/button.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  DimensionValueEditor,
  supportsDimensionFields,
} from "./dimension-value-editor.js";
import { DimensionValueView } from "./dimension-value-view.js";

export interface DimensionEditRequest {
  updates: { id: string; expectedVersion: number; value: JsonValue }[];
  resultId?: string;
  resolution?: "manual" | "skipped" | "retry";
}
export function WorldDimensionsPanel({
  dimensions,
  settlements = [],
  onEdit,
  disabled,
  allowValueEditing = false,
  recoveryOnly = false,
}: {
  dimensions?: DimensionSnapshot;
  settlements?: readonly DimensionSettlementSummary[];
  onEdit?: (
    request: DimensionEditRequest,
    sourceTurnId?: string,
  ) => Promise<void>;
  disabled?: boolean;
  allowValueEditing?: boolean;
  recoveryOnly?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<{
    id: string;
    version: number;
  } | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  async function submit(request: DimensionEditRequest, sourceTurnId?: string) {
    setBusy(true);
    setError(null);
    try {
      await onEdit?.(request, sourceTurnId);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save(id: string) {
    const entry = dimensions?.[id];
    if (!entry || editing?.id !== id) return;
    try {
      const value: unknown = JSON.parse(draft);
      const issues = validateDimensionValue(entry.schema, value, {
        localized: "resolved",
      });
      if (issues.length)
        throw new Error(
          issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
      await submit({
        updates: [
          { id, expectedVersion: editing.version, value: value as JsonValue },
        ],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (
    recoveryOnly &&
    !settlements.some((receipt) => receipt.status === "pending-settlement")
  )
    return null;
  if (
    (!dimensions || !Object.keys(dimensions).length) &&
    !settlements.some((receipt) => receipt.status === "pending-settlement")
  )
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("world.noStructuredData")}
      </p>
    );
  const inactive = disabled || busy;
  return (
    <div className="space-y-4 p-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {settlements
        .filter((receipt) => receipt.status === "pending-settlement")
        .map((receipt) => (
          <section
            key={receipt.source.resultId}
            className="space-y-2 rounded border border-amber-500 p-3"
          >
            <p>
              {t("world.pendingDimensions", "Dimension settlement pending")} ·{" "}
              {receipt.source.turnNumber}
            </p>
            {receipt.error &&
              (allowValueEditing ? (
                <p className="text-sm">{receipt.error}</p>
              ) : (
                <ActionableErrorNotice error={receipt.error} layout="panel" />
              ))}
            {onEdit && (
              <div className="flex flex-wrap gap-2">
                {(allowValueEditing
                  ? (["retry", "manual", "skipped"] as const)
                  : (["retry", "skipped"] as const)
                ).map((resolution) => (
                  <Button
                    key={resolution}
                    variant="outline"
                    size="sm"
                    disabled={
                      inactive ||
                      (resolution === "retry" && !receipt.sourceTurnId)
                    }
                    onClick={() =>
                      void submit(
                        {
                          updates: [],
                          resultId: receipt.source.resultId,
                          resolution,
                        },
                        receipt.sourceTurnId,
                      )
                    }
                  >
                    {t(`world.dimensionResolution.${resolution}`, resolution)}
                  </Button>
                ))}
              </div>
            )}
          </section>
        ))}
      {Object.entries(recoveryOnly ? {} : (dimensions ?? {})).map(
        ([id, entry]) => (
          <section key={id} className="space-y-2 rounded border p-3">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">
                {resolveDisplayText(entry.name, locale)}
              </h3>
              {allowValueEditing && (
                <span className="text-xs text-muted-foreground">
                  {id} · v{entry.version}
                </span>
              )}
              {onEdit && allowValueEditing && (
                <Button
                  className="ml-auto"
                  variant="outline"
                  size="sm"
                  disabled={inactive}
                  onClick={() => {
                    setEditing({ id, version: entry.version });
                    setJsonMode(
                      !supportsDimensionFields(entry.schema, entry.value),
                    );
                    setDraft(JSON.stringify(entry.value, null, 2));
                    setError(null);
                  }}
                >
                  {t("common.edit")}
                </Button>
              )}
            </div>
            {entry.description && (
              <p className="text-sm text-muted-foreground">
                {resolveDisplayText(entry.description, locale)}
              </p>
            )}
            {editing?.id === id ? (
              <div className="space-y-2">
                <label htmlFor={`dimension-value-${id}`} className="text-sm">
                  {t("world.currentValue", "Current value")} · {id}
                </label>
                {supportsDimensionFields(entry.schema, entry.value) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      try {
                        JSON.parse(draft);
                        setJsonMode(!jsonMode);
                      } catch (cause) {
                        setError(String(cause));
                      }
                    }}
                  >
                    {jsonMode
                      ? t("world.dimensionFields", "Edit fields")
                      : t("world.dimensionJson", "Edit JSON")}
                  </Button>
                )}
                {jsonMode ? (
                  <textarea
                    id={`dimension-value-${id}`}
                    className="min-h-40 w-full rounded border bg-background p-2 font-mono text-xs"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : (
                  <DimensionValueEditor
                    schema={entry.schema}
                    value={JSON.parse(draft) as JsonValue}
                    label={`${t("world.currentValue", "Current value")} · ${id}`}
                    onChange={(value) =>
                      setDraft(JSON.stringify(value, null, 2))
                    }
                  />
                )}
                <div className="flex gap-2">
                  <Button disabled={inactive} onClick={() => void save(id)}>
                    {t("common.save")}
                  </Button>
                  <Button
                    disabled={inactive}
                    variant="outline"
                    onClick={() => setEditing(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <DimensionValueView schema={entry.schema} value={entry.value} />
            )}
          </section>
        ),
      )}
    </div>
  );
}
