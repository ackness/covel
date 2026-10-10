/**
 * SuspensionsPanel — UI surface for the suspend/resume flow.
 *
 * Renders the active suspensions list. Each card picks its answer control from
 * the suspension's resume schema (confirm, choice, text, or a form built by the
 * dimension value editor); raw JSON is the fallback only when the schema is
 * missing or no control covers it.
 *
 * The component is presentation-only: state lives in the session-store,
 * mutations go through the `useSession` context callbacks.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DimensionValueSchema, JsonValue } from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import type { SuspensionSummary } from "@/services/api";
import { DimensionValueEditor, emptyValue } from "./dimension-value-editor.js";
import { classifySuspensionInput } from "./suspension-input.js";

interface SuspensionsPanelProps {
  suspensions: readonly SuspensionSummary[];
  onResume: (suspensionId: string, data: unknown) => Promise<void>;
  onCancel: (suspensionId: string) => Promise<void>;
}

export function SuspensionsPanel({
  suspensions,
  onResume,
  onCancel,
}: SuspensionsPanelProps) {
  const { t } = useTranslation();

  if (suspensions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        {t("session.suspensionsEmpty")}
      </p>
    );
  }

  return (
    <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
      {suspensions.map((s) => (
        <SuspensionCard
          key={s.id}
          suspension={s}
          onResume={onResume}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}

interface SuspensionCardProps {
  suspension: SuspensionSummary;
  onResume: (suspensionId: string, data: unknown) => Promise<void>;
  onCancel: (suspensionId: string) => Promise<void>;
}

function SuspensionCard({
  suspension,
  onResume,
  onCancel,
}: SuspensionCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const input = useMemo(
    () => classifySuspensionInput(suspension.resumeSchema),
    [suspension.resumeSchema],
  );
  const [payload, setPayload] = useState("");
  const [formValue, setFormValue] = useState<JsonValue>(() =>
    input.kind === "form" ? emptyValue(input.schema) : null,
  );
  const [busy, setBusy] = useState<"resume" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schema = suspension.resumeSchema;
  const runtimeLabel =
    suspension.runtimeId === suspension.pluginId
      ? suspension.pluginId
      : `${suspension.pluginId} / ${suspension.runtimeId}`;

  const submit = async (data: unknown) => {
    if (busy) return;
    setBusy("resume");
    setError(null);
    try {
      await onResume(suspension.id, data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (busy) return;
    setBusy("cancel");
    setError(null);
    try {
      await onCancel(suspension.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const resumeButton = (
    <Button
      size="sm"
      onClick={() =>
        void submit(
          input.kind === "form"
            ? formValue
            : input.kind === "advanced"
              ? (tryParseJson(payload) ?? payload)
              : payload,
        )
      }
      disabled={busy !== null}
    >
      {busy === "resume" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        t("session.suspensionResumeLabel")
      )}
    </Button>
  );

  return (
    <div className="border border-border rounded-sm p-3 space-y-2 bg-card/40">
      <div className="flex items-start justify-between gap-3 text-xs">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Clock className="w-3 h-3 text-amber-500 shrink-0" />
            <span className="wrap-break-word" title={runtimeLabel}>
              {suspension.reason || runtimeLabel}
            </span>
          </div>
        </div>
        {suspension.createdAt && (
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {formatRelativeTime(suspension.createdAt, t)}
          </span>
        )}
      </div>

      {input.kind === "confirm" && (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void submit(true)}
          >
            {t("session.suspensionConfirmYes")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void submit(false)}
          >
            {t("session.suspensionConfirmNo")}
          </Button>
        </div>
      )}

      {input.kind === "choice" && (
        <div className="flex flex-wrap gap-2">
          {input.options.map((option) => (
            <Button
              key={String(option)}
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void submit(option)}
            >
              {resolveDisplayText(
                (suspension.resumeSchema as DimensionValueSchema)[
                  "x-enumLabels"
                ]?.[String(option)] ?? String(option),
                locale,
              )}
            </Button>
          ))}
        </div>
      )}

      {input.kind === "text" && (
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          aria-label={t("session.suspensionAnswerLabel")}
          placeholder={t("session.suspensionAnswerPlaceholder")}
          disabled={busy !== null}
          className="w-full min-h-18 text-sm bg-background border border-border rounded-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary resize-y disabled:opacity-50"
        />
      )}

      {input.kind === "form" && (
        <DimensionValueEditor
          value={formValue}
          schema={input.schema}
          label={t("session.suspensionAnswerLabel")}
          onChange={setFormValue}
        />
      )}

      {input.kind === "advanced" && (
        <details className="text-xs" open>
          <summary className="cursor-pointer text-muted-foreground">
            {t("session.suspensionAdvanced")}
          </summary>
          {schema !== undefined && schema !== null ? (
            <pre className="mt-2 text-[10px] leading-snug bg-muted/40 p-2 border border-border rounded-sm overflow-x-auto font-mono">
              {renderSchemaHint(schema)}
            </pre>
          ) : null}
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder={t("session.suspensionResumePlaceholder")}
            disabled={busy !== null}
            className="mt-2 w-full min-h-18 text-xs font-mono bg-background border border-border rounded-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary resize-y disabled:opacity-50"
          />
        </details>
      )}

      {error && (
        <p className="text-xs text-destructive wrap-break-word">{error}</p>
      )}

      <div className="flex gap-2 justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCancel}
          disabled={busy !== null}
        >
          {busy === "cancel" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            t("session.suspensionCancelLabel")
          )}
        </Button>
        {input.kind !== "confirm" && input.kind !== "choice" && resumeButton}
      </div>
    </div>
  );
}

/** Try to parse JSON; return null if the string doesn't look like JSON. */
function tryParseJson(s: string): unknown | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (!/^[{["\d\-t f n]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Pretty-print a JSON schema so the user can eyeball the expected shape. */
function renderSchemaHint(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}

/** Coarse "Xm ago" / "Xh ago" formatter; keeps zero external deps. */
function formatRelativeTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const delta = Math.max(0, Date.now() - then);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60)
    return t("session.suspensionAgoSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return t("session.suspensionAgoMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("session.suspensionAgoHours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("session.suspensionAgoDays", { count: days });
}
