import { resolveI18nText } from "@covel/shared";
import { useTranslation } from "react-i18next";
import { ReasoningDisclosure } from "@/components/reasoning-disclosure.js";
import { useMemo, type ReactNode } from "react";
import { ExecutionTimeline } from "../execution-timeline.js";
import { AssetTurnSidebar } from "@/components/asset-render/index.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type { PluginSummary } from "@/services/api.js";
import {
  projectExecutionTurns,
  getSourceTurnId,
  type ExecutionTurn,
} from "@/stores/session-store/execution-projection.js";

interface UseMessageGroupingArgs {
  readonly messages: StreamMessage[];
  readonly executionSteps: ExecutionStep[];
  readonly showExecutionTimeline?: boolean;
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
  showExecutionTimeline = true,
  executing,
  plugins,
  onRetryRuntime,
  renderMessage,
}: UseMessageGroupingArgs): ReactNode[] {
  const { i18n } = useTranslation();
  const projection = useMemo(
    () => projectExecutionTurns(messages, executionSteps),
    [messages, executionSteps],
  );

  const reasoningByTurn = useMemo(() => {
    const sources = new Map(
      executionSteps.flatMap((step) =>
        step.turnId && step.sourceTurnId
          ? [[step.turnId, step.sourceTurnId] as const]
          : [],
      ),
    );
    const grouped = new Map<
      string | undefined,
      Array<{
        id: string;
        content: string;
        label: string;
        timestamp: string;
        sequence?: number;
      }>
    >();
    for (const step of executionSteps) {
      const turnId = getSourceTurnId(step.turnId, sources);
      const label =
        step.label ||
        resolveI18nText(
          plugins.find((plugin) => plugin.id === step.pluginId)?.displayName,
          i18n.language,
        ) ||
        step.pluginId ||
        step.runtimeId;
      const entries = (step.reasoning ?? []).map((entry) => ({
        ...entry,
        label: `${label} · ${step.runtimeId}${entry.model ? ` · ${entry.model}` : ""}`,
      }));
      if (entries.length)
        grouped.set(turnId, [...(grouped.get(turnId) ?? []), ...entries]);
    }
    for (const entries of grouped.values())
      entries.sort(
        (a, b) =>
          a.timestamp.localeCompare(b.timestamp) ||
          (a.sequence ?? 0) - (b.sequence ?? 0),
      );
    return grouped;
  }, [executionSteps, plugins, i18n.language]);
  const pendingMessage = messages.at(-1);
  const awaitingTurnIdentity =
    executing && pendingMessage?.role === "user" && !pendingMessage.turnId;
  const latestTurn = awaitingTurnIdentity ? undefined : projection.latestTurn;
  const rendered: ReactNode[] = [];
  const addRow = (
    key: string,
    node: ReactNode,
    group: ExecutionTurn,
    kind: "message" | "execution" | "assets" | "reasoning",
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
    const reasoning = reasoningByTurn.get(group.turnId);
    if (reasoning?.length)
      addRow(
        `reasoning-${group.key}`,
        <ReasoningDisclosure entries={reasoning} />,
        group,
        "reasoning",
      );
    const isLatestTurn = group === latestTurn;
    const canRetry =
      isLatestTurn && !executing && !!group.turnId && !!onRetryRuntime;
    if (showExecutionTimeline && group.steps.length > 0) {
      addRow(
        `exec-${group.turnId ?? "__unknown__"}`,
        <ExecutionTimeline
          steps={group.steps}
          messages={group.messages.map((entry) => entry.message)}
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
