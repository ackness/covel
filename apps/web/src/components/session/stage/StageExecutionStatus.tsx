import { useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectExecutionTurns } from "@/stores/session-store/execution-projection.js";
import { ExecutionTimeline } from "../execution-timeline.js";
import type { StageViewProps } from "./StageView.js";

type Props = Pick<
  StageViewProps,
  | "messages"
  | "executionSteps"
  | "executing"
  | "executionError"
  | "plugins"
  | "onRetryRuntime"
>;

/** Stage and chat share the same source-turn task projection and retry target. */
export function StageExecutionStatus({
  messages,
  executionSteps,
  executing,
  executionError,
  plugins,
  onRetryRuntime,
}: Props) {
  const { t } = useTranslation();
  const { latestTurn } = useMemo(
    () => projectExecutionTurns(messages, executionSteps),
    [messages, executionSteps],
  );
  const pendingMessage = messages.at(-1);
  const awaitingTurnIdentity =
    executing && pendingMessage?.role === "user" && !pendingMessage.turnId;
  const turn = awaitingTurnIdentity ? undefined : latestTurn;
  const showTasks =
    !!turn?.steps.length &&
    (executing || turn.steps.some((step) => step.status === "failed"));
  if (!showTasks && !executionError) return null;
  const canRetry = !executing && !!turn?.turnId && !!onRetryRuntime;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-14 z-50 flex justify-center px-4"
      data-testid="stage-execution-status"
      data-turn-id={turn?.turnId}
    >
      <div className="ui-stage-panel pointer-events-auto max-h-[45vh] w-full max-w-2xl overflow-y-auto rounded-(--radius-card) px-4 py-3 text-sm">
        {showTasks && turn && (
          <ExecutionTimeline
            steps={turn.steps}
            executing={executing}
            plugins={plugins}
            turnNumberStart={turn.turnNumber}
            canRetryTasks={turn.sourceCommitted === true}
            onRetryRuntime={
              canRetry && turn.sourceCommitted === true
                ? (runtimeId) => onRetryRuntime?.(runtimeId, turn.turnId)
                : undefined
            }
          />
        )}
        {executionError && (
          <div className="flex items-start gap-2" data-testid="stage-error">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-destructive">
                {t("common.error")}
              </p>
              <p className="mt-1 wrap-break-word text-xs text-muted-foreground">
                {executionError}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
