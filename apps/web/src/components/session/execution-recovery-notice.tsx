import { useContext, useEffect, useState } from "react";
import { RefreshCw, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ExecutionRecovery,
  ExecutionStep,
} from "@/stores/session-store/types.js";
import { PLAYER_ABORT_REASON } from "@covel/shared";
import { useNotice, type NoticeTone } from "@/lib/notice-center.js";
import {
  ProviderFailureNotice,
  SessionModelUsesContext,
} from "./provider-failure-notice.js";
import { FailureRecoveryActions } from "./failure-recovery-actions.js";
import { executionRecoveryNoticeVisible } from "./execution-presentation.js";
import { I18N_SENTINEL_PREFIX } from "./execution-runtime-status.js";

const RECOVERY_MESSAGES = {
  stalled: {
    title: "session.recoveryUnconfirmed",
    detail: "session.recoveryUnconfirmedDetail",
  },
  unavailable: {
    title: "session.recoveryChecking",
    detail: "session.recoveryUnavailableDetail",
  },
  unknown: {
    title: "session.recoveryChecking",
    detail: "session.recoveryUnknownDetail",
  },
  running: {
    title: "session.recoveryRunning",
    detail: "session.recoveryRunningDetail",
  },
  interrupted: {
    title: "session.recoveryInterrupted",
    detail: "session.recoveryInterruptedDetail",
  },
  stopped: {
    title: "session.executionState.stopped",
    detail: "session.stoppedDetail",
  },
  failed: {
    title: "session.recoveryFailed",
    detail: "session.recoveryInterruptedDetail",
  },
  hydrating: {
    title: "session.recoveryHydrating",
    detail: "session.recoveryHydratingDetail",
  },
} as const;

/**
 * The turn that did not finish, as a card with the way to retry it. The card
 * exists while the recovery state asks for attention and goes away when the
 * turn is settled; nothing is rendered in the page column.
 */
export function ExecutionRecoveryNotice({
  recovery,
  steps = [],
  onRetry,
  onRefresh,
  onStop,
  onOpenSettings,
}: {
  recovery: ExecutionRecovery | null | undefined;
  steps?: readonly ExecutionStep[];
  onRetry: () => void;
  onRefresh: () => void;
  onStop: () => Promise<void>;
  onOpenSettings: (key: "llm.providers" | "llm.slots") => void;
}): null {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState(false);
  // The card body renders in the notice host, outside the game view.
  const modelUses = useContext(SessionModelUsesContext);
  useEffect(() => {
    setBusy(false);
  }, [recovery?.status?.turnId, recovery?.status?.state, recovery?.hydrating]);
  const visible = !!recovery && executionRecoveryNoticeVisible(recovery);
  const status = recovery?.status;
  // The server could not tell whether a turn runs; `stalled` once it gave up.
  const unavailable = status?.state === "unknown";
  const stalled = unavailable && !!recovery?.stalled;
  const unknown = !!recovery?.error || !status || unavailable;
  const running = status?.state === "running";
  const interrupted = status?.state === "interrupted";
  const failed = status?.state === "failed";
  const stopped = failed && status?.abortReason === PLAYER_ABORT_REASON;
  const waiting = !stalled && (!!recovery?.hydrating || running || unknown);
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
        : stopped && retry?.type === "retry_turn"
          ? t("session.continueStoppedOpening")
          : t("session.recoveryRetry");
  const phase = stalled
    ? "stalled"
    : unavailable
      ? "unavailable"
      : unknown
        ? "unknown"
        : running
          ? "running"
          : interrupted
            ? "interrupted"
            : stopped
              ? "stopped"
              : failed
                ? "failed"
                : "hydrating";
  const { title, detail } = RECOVERY_MESSAGES[phase];
  const failedStep =
    (phase === "failed" || phase === "interrupted") && status?.turnId
      ? steps.find(
          (step) =>
            step.turnId === status.turnId &&
            step.status === "failed" &&
            !step.detached &&
            step.detail &&
            !step.detail.startsWith(I18N_SENTINEL_PREFIX),
        )
      : undefined;
  const error = failedStep?.detail;
  const canRetry =
    !!status?.retry &&
    (interrupted || failed) &&
    !recovery?.hydrating &&
    !unknown;
  // A turn that is not being checked or stopped on purpose needs the player.
  const tone: NoticeTone = waiting || stopped ? "info" : "error";
  useNotice(
    visible
      ? {
          key: "execution-recovery",
          kind: "card",
          tone,
          title: t(title),
          ...(error ? {} : { body: t(detail) }),
          render: () => (
            <SessionModelUsesContext.Provider value={modelUses}>
              {error && (
                <ProviderFailureNotice
                  error={error}
                  errorKind={failedStep?.errorKind}
                  failureTarget={failedStep?.failureTarget}
                  layout="panel"
                />
              )}
              {stopError && (
                <p className="text-xs text-destructive">
                  {t("session.recoveryStopFailed")}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                <FailureRecoveryActions
                  error={error}
                  errorKind={failedStep?.errorKind}
                  retryLabel={retryLabel}
                  disabled={busy || recovery?.checking}
                  onOpenSettings={onOpenSettings}
                  onRetry={
                    canRetry
                      ? () => {
                          setBusy(true);
                          onRetry();
                        }
                      : undefined
                  }
                />
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
            </SessionModelUsesContext.Provider>
          ),
        }
      : null,
  );
  return null;
}
