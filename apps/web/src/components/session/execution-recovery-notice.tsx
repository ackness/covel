import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExecutionRecovery } from "@/stores/session-store/types.js";

export function ExecutionRecoveryNotice({
  recovery,
  onRetry,
  onRefresh,
  onStop,
}: {
  recovery: ExecutionRecovery | null | undefined;
  onRetry: () => void;
  onRefresh: () => void;
  onStop: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState(false);
  useEffect(() => {
    setBusy(false);
  }, [recovery?.status?.turnId, recovery?.status?.state, recovery?.hydrating]);
  if (!recovery) return null;
  const status = recovery.status;
  const unknown = !!recovery.error || !status;
  const running = status?.state === "running";
  const interrupted = status?.state === "interrupted";
  const failed = status?.state === "failed";
  if (!unknown && !running && !interrupted && !failed && !recovery.hydrating)
    return null;
  const waiting = recovery.hydrating || running || unknown;
  const retry = status?.retry;
  const retryLabel =
    retry?.type === "retry_runtime"
      ? t("session.retryTask")
      : retry?.type === "retry_failed_runtimes"
        ? t("session.retryFailedTasks", {
            count: Array.isArray(retry.payload.runtimeIds)
              ? retry.payload.runtimeIds.length
              : 0,
          })
        : t("session.recoveryRetry");
  const title = unknown
    ? "session.recoveryChecking"
    : running
      ? "session.recoveryRunning"
      : interrupted
        ? "session.recoveryInterrupted"
        : failed
          ? "session.recoveryFailed"
          : "session.recoveryHydrating";
  const detail = unknown
    ? "session.recoveryUnknownDetail"
    : running
      ? "session.recoveryRunningDetail"
      : interrupted || failed
        ? "session.recoveryInterruptedDetail"
        : "session.recoveryHydratingDetail";
  return (
    <div
      role={waiting ? "status" : "alert"}
      className="relative z-10 shrink-0 border-b border-border bg-background/95 px-4 py-3 text-foreground"
      data-testid="execution-recovery-notice"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-start gap-3">
        {waiting ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium">{t(title)}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(detail)}
          </p>
          {stopError && (
            <p className="mt-1 text-xs text-destructive">
              {t("session.recoveryStopFailed")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.retry &&
            (interrupted || failed) &&
            !recovery.hydrating &&
            !unknown && (
              <button
                type="button"
                disabled={busy || recovery.checking}
                onClick={() => {
                  setBusy(true);
                  onRetry();
                }}
                className="rounded-(--radius-control) bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                {retryLabel}
              </button>
            )}
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            {t("session.recoveryRefresh")}
          </button>
          {running && !unknown && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setStopError(false);
                void onStop()
                  .then(onRefresh)
                  .catch(() => setStopError(true))
                  .finally(() => setBusy(false));
              }}
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              {t("session.recoveryStop")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
