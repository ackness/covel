import { type ReactNode } from "react";
import { ExecutionTimeline } from "../execution-timeline.js";
import { AssetTurnSidebar } from "@/components/asset-render/index.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type { PackageSummary } from "@/services/api.js";

interface UseMessageGroupingArgs {
  readonly messages: StreamMessage[];
  readonly executionSteps: ExecutionStep[];
  readonly executing: boolean;
  readonly packages: PackageSummary[];
  readonly onRetryRuntime?: (runtimeId: string | undefined) => void;
  readonly renderMessage: (msg: StreamMessage, index: number) => ReactNode;
}

/**
 * Interleaves message rows with per-turn execution timelines and asset
 * sidebars. Each turn's timeline is inserted after that turn's last message;
 * steps belonging to turns with no messages yet (e.g. startup) render at the
 * bottom. Rows are wrapped in `.chat-row` so off-screen rows skip layout/paint
 * (content-visibility) while preserving keys, refs, state, scroll anchoring,
 * streaming follow and jump-to-latest.
 *
 * Plain per-render computation (mirrors the original inline grouping) — the
 * inputs change each turn and `renderMessage` closes over live props/state, so
 * memoisation would offer no benefit and risk stale rows.
 */
export function useMessageGrouping({
  messages,
  executionSteps,
  executing,
  packages,
  onRetryRuntime,
  renderMessage,
}: UseMessageGroupingArgs): ReactNode[] {
  // Group execution steps by turnId for inline rendering
  const stepsByTurn = new Map<string, ExecutionStep[]>();
  for (const step of executionSteps) {
    const tid = step.turnId ?? "__unknown__";
    if (!stepsByTurn.has(tid)) stepsByTurn.set(tid, []);
    stepsByTurn.get(tid)!.push(step);
  }

  // Collect the last message index per turnId so we know where to insert
  const lastMsgIndexByTurn = new Map<string, number>();
  messages.forEach((msg, idx) => {
    if (msg.turnId) lastMsgIndexByTurn.set(msg.turnId, idx);
  });

  const rendered: ReactNode[] = [];
  const insertedTurnIds = new Set<string>();

  messages.forEach((msg, idx) => {
    const node = renderMessage(msg, idx);
    if (node) rendered.push(node);

    // After the last message of a turn, insert that turn's execution timeline
    if (msg.turnId && lastMsgIndexByTurn.get(msg.turnId) === idx) {
      const turnSteps = stepsByTurn.get(msg.turnId);
      if (turnSteps && turnSteps.length > 0) {
        insertedTurnIds.add(msg.turnId);
        const isActiveTurn =
          executing && msg.turnId === [...lastMsgIndexByTurn.keys()].at(-1);
        rendered.push(
          <ExecutionTimeline
            key={`exec-${msg.turnId}`}
            steps={turnSteps}
            executing={isActiveTurn ? executing : false}
            packages={packages}
            onRetryRuntime={
              isActiveTurn && onRetryRuntime
                ? (id) => onRetryRuntime(id)
                : undefined
            }
            onRetryAll={
              isActiveTurn && onRetryRuntime
                ? () => onRetryRuntime(undefined)
                : undefined
            }
          />,
        );
      }
      // P0-b — surface modality-routed assets emitted by this turn out-of-band,
      // so plain narrative turns stay untouched while image / audio /
      // generic-link assets show up next to the execution timeline. Renders
      // nothing when the turn has no assets, so this is a layout no-op for
      // text-only turns.
      rendered.push(
        <AssetTurnSidebar key={`assets-${msg.turnId}`} turnId={msg.turnId} />,
      );
    }
  });

  // If the current turn is executing and has no messages yet (startup), or
  // steps belong to a turn with no messages, show at the bottom.
  const activeTurnSteps = executionSteps.filter((s) => {
    const tid = s.turnId ?? "__unknown__";
    return !insertedTurnIds.has(tid);
  });
  if (activeTurnSteps.length > 0) {
    rendered.push(
      <ExecutionTimeline
        key="exec-active"
        steps={activeTurnSteps}
        executing={executing}
        packages={packages}
        onRetryRuntime={onRetryRuntime ? (id) => onRetryRuntime(id) : undefined}
        onRetryAll={
          onRetryRuntime ? () => onRetryRuntime(undefined) : undefined
        }
      />,
    );
  }

  // Wrap each row in a `.chat-row` so off-screen rows skip layout and paint
  // (content-visibility) — preserves keys, refs, state, scroll anchoring,
  // streaming follow and jump-to-latest.
  return rendered.map((node) => {
    const el = node as React.ReactElement;
    return (
      <div key={el.key} className="chat-row">
        {node}
      </div>
    );
  });
}
