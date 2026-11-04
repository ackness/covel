import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText, type PluginSummary } from "@covel/shared";
import { useNotice } from "@/lib/notice-center.js";
import {
  ProviderFailureNotice,
  SessionModelUsesContext,
} from "./provider-failure-notice.js";
import type { SessionRecord, SetupRuntimeState } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import type {
  ExecutionRecovery,
  ExecutionStep,
} from "@/stores/session-store/types.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";
import { FailureRecoveryActions } from "./failure-recovery-actions.js";
import { executionRecoveryNoticeVisible } from "./execution-presentation.js";

/**
 * A session that sits in setup with nothing on screen to act on: a setup step
 * failed, or the page was closed between a form and the run that reads it.
 */
export interface SetupProgress {
  /** `failed`: a step reported an error. `unfinished`: setup only has to run again. */
  readonly kind: "failed" | "unfinished";
  /** Steps out of retries; each is re-armed before setup runs again. */
  readonly blocked: readonly string[];
  /** The error of the first failing step, when it recorded one. */
  readonly error?: string;
  readonly errorKind?: string;
  readonly failureTarget?: ExecutionStep["failureTarget"];
  readonly waitingOn?: readonly string[];
}

function setupError(state: SetupRuntimeState): string | undefined {
  if (state.state === "pending") return state.lastError;
  if (state.state === "blocked") return state.lastError ?? state.reason;
  return undefined;
}

export function setupProgress(input: {
  readonly session: SessionRecord;
  readonly messages: StreamMessage[];
  readonly submittedBlockIds: ReadonlySet<string>;
  readonly executing: boolean;
  readonly recovery?: ExecutionRecovery | null;
  readonly steps?: readonly ExecutionStep[];
  readonly plugins?: readonly Pick<PluginSummary, "id" | "displayName">[];
  readonly locale?: string;
}): SetupProgress | null {
  const { session, messages, submittedBlockIds, executing } = input;
  if (session.status !== "active" || session.phase !== "setup") return null;
  if (executing || executionRecoveryNoticeVisible(input.recovery)) return null;
  const states = Object.entries(session.setupRuntimes ?? {});
  // Keep the initial hero clear, but an attempted setup can leave no chat
  // messages at all (for example a function waiting on unavailable state).
  const attempted =
    states.some(
      ([, state]) => state.state !== "pending" || state.attempts > 0,
    ) ||
    input.steps?.some((step) => step.stage === "setup") ||
    input.recovery?.status?.state === "completed";
  if (messages.length === 0 && !attempted) return null;
  // A form or choice on screen is what setup waits for.
  if (
    messages.some((message) =>
      isPendingInteractionMessage(message, messages, submittedBlockIds),
    )
  )
    return null;
  const blocked = states
    .filter(([, state]) => state.state === "blocked")
    .map(([runtimeId]) => runtimeId);
  const failed = states.find(([, state]) => setupError(state) !== undefined);
  const error = failed ? setupError(failed[1]) : undefined;
  // The session clock identifies the outstanding setup failure; its matching
  // lifecycle row supplies the structured target, live or after hydration.
  const step = failed
    ? [...(input.steps ?? [])]
        .reverse()
        .find(
          (step) =>
            step.runtimeId === failed[0] &&
            step.status === "failed" &&
            step.detail === error,
        )
    : undefined;
  const waitingOn = [
    ...new Set(
      states
        .filter(([, state]) => state.state === "pending")
        .map(([runtimeId]) => {
          const pluginId = runtimeId.split("/")[0] ?? runtimeId;
          const plugin = input.plugins?.find(
            (plugin) => plugin.id === pluginId,
          );
          return resolveI18nText(plugin?.displayName, input.locale) || pluginId;
        }),
    ),
  ];
  return blocked.length > 0 || error !== undefined
    ? {
        kind: "failed",
        blocked,
        ...(error ? { error } : {}),
        ...(step
          ? { errorKind: step.errorKind, failureTarget: step.failureTarget }
          : {}),
      }
    : {
        kind: "unfinished",
        blocked,
        ...(waitingOn.length > 0 ? { waitingOn } : {}),
      };
}

/** The session record trails the end of a run by one request; wait it out. */
const SETTLE_MS = 1200;

/**
 * A game stuck in its preparation with nothing on screen to act on, as a card
 * with the way to continue. While preparation runs, the session header's
 * status chip says so.
 */
export function SetupProgressNotice({
  progress,
  onRearm,
  onRun,
  onOpenSettings,
}: {
  progress: SetupProgress | null;
  /** Re-arm one blocked setup step. */
  onRearm: (runtimeId: string) => Promise<void>;
  /** Run setup again without a player message. */
  onRun: () => void;
  onOpenSettings: (key: "llm.providers" | "llm.slots") => void;
}): null {
  const { t } = useTranslation();
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rearmFailed, setRearmFailed] = useState(false);
  // The card body renders in the notice host, outside the game view.
  const modelUses = useContext(SessionModelUsesContext);
  const visible = progress !== null;
  useEffect(() => {
    setSettled(false);
    setBusy(false);
    if (!visible) return;
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  const failed = progress?.kind === "failed";
  const run = async () => {
    if (!progress) return;
    setBusy(true);
    setRearmFailed(false);
    try {
      for (const runtimeId of progress.blocked) await onRearm(runtimeId);
      onRun();
    } catch {
      setRearmFailed(true);
      setBusy(false);
    }
  };
  useNotice(
    !progress || !settled
      ? null
      : {
          key: "setup-progress",
          kind: "card",
          tone: failed ? "error" : "info",
          title: t(
            failed
              ? "session.setupFailedTitle"
              : "session.setupUnfinishedTitle",
          ),
          ...(progress.error
            ? {}
            : {
                body: [
                  t(
                    failed
                      ? "session.setupFailedDetail"
                      : "session.setupUnfinishedDetail",
                  ),
                  ...(!failed && progress.waitingOn
                    ? [
                        t("session.setupWaitingOn", {
                          plugins: progress.waitingOn.join(", "),
                        }),
                      ]
                    : []),
                ].join("\n"),
              }),
          render: () => (
            <SessionModelUsesContext.Provider value={modelUses}>
              {progress.error && (
                <ProviderFailureNotice
                  error={progress.error}
                  errorKind={progress.errorKind}
                  failureTarget={progress.failureTarget}
                  layout="panel"
                />
              )}
              {rearmFailed && (
                <p className="text-xs text-destructive">
                  {t("session.setupRetryFailed")}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <FailureRecoveryActions
                  error={failed ? progress.error : undefined}
                  errorKind={failed ? progress.errorKind : undefined}
                  retryLabel={t(
                    failed ? "session.setupRetry" : "session.setupContinue",
                  )}
                  disabled={busy}
                  onRetry={() => void run()}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            </SessionModelUsesContext.Provider>
          ),
        },
  );
  return null;
}
