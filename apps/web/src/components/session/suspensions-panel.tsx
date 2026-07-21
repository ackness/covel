/**
 * SuspensionsPanel — UI surface for the suspend/resume flow.
 *
 * Renders the active suspensions list plus a minimal resume form. The form
 * accepts free-form JSON or text and submits through the api.resumeSuspension
 * wrapper. `expectedResumeSchema` (when the plugin declared one) is rendered
 * as a read-only hint so the player knows which shape to type.
 *
 * The component is presentation-only: state lives in the session-store,
 * mutations go through the `useSession` context callbacks.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SuspensionRecord } from "@/services/api";

interface SuspensionsPanelProps {
  suspensions: readonly SuspensionRecord[];
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
  suspension: SuspensionRecord;
  onResume: (suspensionId: string, data: unknown) => Promise<void>;
  onCancel: (suspensionId: string) => Promise<void>;
}

function SuspensionCard({
  suspension,
  onResume,
  onCancel,
}: SuspensionCardProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState<"resume" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schema = suspension.resumeSchema;
  const runtimeLabel =
    suspension.runtimeId === suspension.pluginId
      ? suspension.pluginId
      : `${suspension.pluginId} / ${suspension.runtimeId}`;

  const handleResume = async () => {
    if (busy) return;
    setBusy("resume");
    setError(null);
    try {
      const data = tryParseJson(payload) ?? payload;
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

  return (
    <div className="border border-border rounded-sm p-3 space-y-2 bg-card/40">
      <div className="flex items-start justify-between gap-3 text-xs">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Clock className="w-3 h-3 text-amber-500 shrink-0" />
            <span className="truncate" title={runtimeLabel}>
              {runtimeLabel}
            </span>
          </div>
          {suspension.reason && (
            <p className="mt-1 text-muted-foreground break-words">
              {suspension.reason}
            </p>
          )}
        </div>
        {suspension.suspendedAt && (
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {formatRelativeTime(suspension.suspendedAt, t)}
          </span>
        )}
      </div>

      {schema ? (
        <pre className="text-[10px] leading-snug bg-muted/40 p-2 border border-border rounded-sm overflow-x-auto font-mono">
          {renderSchemaHint(schema)}
        </pre>
      ) : null}

      <textarea
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        placeholder={t("session.suspensionResumePlaceholder")}
        disabled={busy !== null}
        className="w-full min-h-[72px] text-xs font-mono bg-background border border-border rounded-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary resize-y disabled:opacity-50"
      />

      {error && <p className="text-xs text-destructive break-words">{error}</p>}

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
        <Button size="sm" onClick={handleResume} disabled={busy !== null}>
          {busy === "resume" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            t("session.suspensionResumeLabel")
          )}
        </Button>
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
