import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionMemoryIndexStatus } from "@covel/shared";
import {
  getSessionMemoryIndex,
  rebuildSessionMemoryIndex,
} from "@/services/api";
import { ApiError } from "@/services/api/request.js";

function modelLabel(model: {
  readonly provider: string;
  readonly modelName: string;
}): string {
  return model.provider
    ? `${model.provider}/${model.modelName}`
    : model.modelName;
}

function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as { reason?: unknown } | undefined;
    if (typeof details?.reason === "string") return details.reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session's memory was indexed with an embedding model the settings no
 * longer select: memory search matches keywords only until the index is
 * rebuilt with the configured model (or cleared when none is configured).
 */
export function MemoryIndexNotice({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  /** Changing it checks again, e.g. after the model settings were closed. */
  refreshKey?: unknown;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SessionMemoryIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    getSessionMemoryIndex(sessionId).then(
      (next) => {
        if (current) setStatus(next);
      },
      () => {
        // A server without the session (browser-private play) or without a
        // vector index has nothing to report.
        if (current) setStatus(null);
      },
    );
    return () => {
      current = false;
    };
  }, [sessionId, refreshKey]);

  if (!status?.stale || !status.locked) return null;
  const locked = modelLabel(status.locked);
  const configured = status.configured ? modelLabel(status.configured) : null;

  const rebuild = () => {
    setBusy(true);
    setError(null);
    rebuildSessionMemoryIndex(sessionId)
      .then(setStatus, (cause: unknown) => setError(failureReason(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      role="status"
      className="relative z-10 shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-foreground"
      data-testid="memory-index-notice"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium">
            {t("session.memoryIndex.staleTitle")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {configured
              ? t("session.memoryIndex.staleDetail", { locked, configured })
              : t("session.memoryIndex.noModelDetail", { locked })}
          </p>
          {error && (
            <p className="mt-1 text-xs text-destructive">
              {t("session.memoryIndex.failed", { reason: error })}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={rebuild}
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {busy
            ? t("session.memoryIndex.rebuilding")
            : configured
              ? t("session.memoryIndex.rebuild")
              : t("session.memoryIndex.clear")}
        </button>
      </div>
    </div>
  );
}
