import { useEffect, useState } from "react";
import { AlertCircle, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ActionableErrorNotice } from "@/components/shared/actionable-error-notice.js";
import type { SessionRecord, SetupRuntimeState } from "@/services/api.js";
import type { StreamMessage } from "@/stores/session-store.js";
import type { ExecutionRecovery } from "@/stores/session-store/types.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";

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
}

function setupError(state: SetupRuntimeState): string | undefined {
  if (state.state === "pending") return state.lastError;
  if (state.state === "blocked") return state.lastError ?? state.reason;
  return undefined;
}

/** The recovery notice owns an interrupted or failed execution. */
function recoveryActive(recovery: ExecutionRecovery | null | undefined) {
  if (!recovery) return false;
  const state = recovery.status?.state;
  return (
    recovery.hydrating ||
    !!recovery.error ||
    !recovery.status ||
    state === "running" ||
    state === "interrupted" ||
    state === "failed"
  );
}

export function setupProgress(input: {
  readonly session: SessionRecord;
  readonly messages: StreamMessage[];
  readonly submittedBlockIds: ReadonlySet<string>;
  readonly executing: boolean;
  readonly recovery?: ExecutionRecovery | null;
}): SetupProgress | null {
  const { session, messages, submittedBlockIds, executing } = input;
  if (session.status !== "active" || session.phase !== "setup") return null;
  // No messages yet: the "begin adventure" hero is the way forward.
  if (executing || messages.length === 0 || recoveryActive(input.recovery))
    return null;
  // A form or choice on screen is what setup waits for.
  if (
    messages.some((message) =>
      isPendingInteractionMessage(message, messages, submittedBlockIds),
    )
  )
    return null;
  const states = Object.entries(session.setupRuntimes ?? {});
  const blocked = states
    .filter(([, state]) => state.state === "blocked")
    .map(([runtimeId]) => runtimeId);
  const error = states
    .map(([, state]) => setupError(state))
    .find((text) => text !== undefined);
  return blocked.length > 0 || error !== undefined
    ? { kind: "failed", blocked, ...(error ? { error } : {}) }
    : { kind: "unfinished", blocked };
}

/** The session record trails the end of a run by one request; wait it out. */
const SETTLE_MS = 1200;

export function SetupProgressNotice({
  progress,
  onRearm,
  onRun,
}: {
  progress: SetupProgress | null;
  /** Re-arm one blocked setup step. */
  onRearm: (runtimeId: string) => Promise<void>;
  /** Run setup again without a player message. */
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rearmFailed, setRearmFailed] = useState(false);
  const visible = progress !== null;
  useEffect(() => {
    setSettled(false);
    setBusy(false);
    if (!visible) return;
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!progress || !settled) return null;
  const failed = progress.kind === "failed";
  const run = async () => {
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
  return (
    <div
      role={failed ? "alert" : "status"}
      className="relative z-10 shrink-0 border-b border-border bg-background/95 px-4 py-3 text-foreground"
      data-testid="setup-progress-notice"
      data-kind={progress.kind}
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-start gap-3">
        {failed ? (
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        ) : (
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium">
            {t(
              failed
                ? "session.setupFailedTitle"
                : "session.setupUnfinishedTitle",
            )}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(
              failed
                ? "session.setupFailedDetail"
                : "session.setupUnfinishedDetail",
            )}
          </p>
          {progress.error && (
            <div className="mt-1.5">
              <ActionableErrorNotice error={progress.error} layout="panel" />
            </div>
          )}
          {rearmFailed && (
            <p className="mt-1 text-xs text-destructive">
              {t("session.setupRetryFailed")}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="rounded-(--radius-control) bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {t(failed ? "session.setupRetry" : "session.setupContinue")}
        </button>
      </div>
    </div>
  );
}
