import { useMemo, type ReactNode } from "react";
import { ExecutionTimeline } from "../execution-timeline.js";
import { AssetTurnSidebar } from "@/components/asset-render/index.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type { PluginSummary } from "@/services/api.js";
import {
  projectExecutionTurns,
  type ExecutionTurn,
} from "@/stores/session-store/execution-projection.js";

interface UseMessageGroupingArgs {
  readonly messages: StreamMessage[];
  readonly executionSteps: ExecutionStep[];
  readonly executing: boolean;
  readonly plugins: PluginSummary[];
  readonly onRetryRuntime?: (
    runtimeId: string | readonly string[] | undefined,
    sourceTurnId?: string,
  ) => void;
  readonly renderMessage: (msg: StreamMessage, index: number) => ReactNode;
}

/**
 * Keep messages, execution and assets together in turn order. A turn without
 * messages still has a place in history; it must not become the current turn
 * merely because its timeline used to be appended after every message.
 * Streaming text lives outside messages, so grouping remains stable per token.
 */
export function useMessageGrouping({
  messages,
  executionSteps,
  executing,
  plugins,
  onRetryRuntime,
  renderMessage,
}: UseMessageGroupingArgs): ReactNode[] {
  const projection = useMemo(
    () => projectExecutionTurns(messages, executionSteps),
    [messages, executionSteps],
  );

  const pendingMessage = messages.at(-1);
  const awaitingTurnIdentity =
    executing && pendingMessage?.role === "user" && !pendingMessage.turnId;
  const latestTurn = awaitingTurnIdentity ? undefined : projection.latestTurn;
  const rendered: ReactNode[] = [];
  const addRow = (
    key: string,
    node: ReactNode,
    group: ExecutionTurn,
    kind: "message" | "execution" | "assets",
  ) => {
    if (!node) return;
    rendered.push(
      <div
        key={key}
        className="chat-row"
        data-turn-id={group.turnId}
        data-row-kind={kind}
        data-turn-current={group === latestTurn}
      >
        {node}
      </div>,
    );
  };

  for (const group of projection.turns) {
    for (const { message, index } of group.messages) {
      addRow(message.id, renderMessage(message, index), group, "message");
    }
    const isLatestTurn = group === latestTurn;
    const canRetry =
      isLatestTurn && !executing && !!group.turnId && !!onRetryRuntime;
    if (group.steps.length > 0) {
      addRow(
        `exec-${group.turnId ?? "__unknown__"}`,
        <ExecutionTimeline
          steps={group.steps}
          executing={executing && isLatestTurn}
          isLatestTurn={isLatestTurn}
          turnNumberStart={group.turnNumber}
          plugins={plugins}
          canRetryTasks={group.sourceCommitted === true}
          onRetryRuntime={
            canRetry && group.sourceCommitted === true
              ? (id) => onRetryRuntime?.(id, group.turnId)
              : undefined
          }
        />,
        group,
        "execution",
      );
    }
    if (group.turnId && group.messages.length > 0) {
      addRow(
        `assets-${group.turnId}`,
        <AssetTurnSidebar turnId={group.turnId} />,
        group,
        "assets",
      );
    }
  }
  return rendered;
}
