import type * as api from "@/services/api.js";
import {
  categorize,
  traceEventIdentity,
  type EventCategory,
} from "./-debug-helpers.js";

export type DebugView = "traces" | "data" | "cost";

export interface VisibleTurn {
  turn: api.TurnTrace;
  turnIndex: number;
}

export function isManualTurn(turn: api.TurnTrace): boolean {
  return turn.events.some(
    (event) =>
      event.type === "turn.started" &&
      event.payload &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).manualTrigger,
  );
}

export function getStoryTurnCount(turns: api.TurnTrace[]): number {
  return turns.reduce((count, turn) => count + (isManualTurn(turn) ? 0 : 1), 0);
}

export function getVisibleTurns(turns: api.TurnTrace[]): VisibleTurn[] {
  let storyIndex = 0;
  return turns.map((turn) => {
    if (!isManualTurn(turn)) storyIndex++;
    return { turn, turnIndex: storyIndex };
  });
}

export function traceEventMatchesCategory(
  event: api.TraceEvent,
  category: EventCategory | null,
): boolean {
  return (
    category === null ||
    categorize(event.type) === category ||
    categorize((event.payload.type as string) || event.type) === category
  );
}

/**
 * 事件去重键：跨窗口翻页 / 自动刷新最新窗口时，同一事件可能重复出现，
 * 用尽量多的判别字段避免重复计入。seq 在同一会话内通常单调递增，
 * 仍叠加 requestId/traceId/type/timestamp 以求稳妥。
 */
function traceEventKey(event: api.TraceEvent): string {
  return traceEventIdentity(event);
}

/** 取两个时间戳里较早的非空值（空串视为缺失，不参与比较）。 */
function earlierTimestamp(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** 取两个时间戳里较晚的非空值（空串视为缺失，不参与比较）。 */
function laterTimestamp(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * 按 turnId 合并两批 turn。分页单位是「事件」，一个 turn 可能被窗口边界切开，
 * 因此加载更旧一页 / 自动刷新最新窗口后，需要把同 turnId 的 events 合并去重、
 * 重算 eventCount、重排 startedAt/completedAt，并整体按 startedAt 正序输出
 * （与后端 `/turns` 顺序一致）。纯函数，不修改入参；内容没有变化时返回
 * `existing` 原引用，避免 Live 轮询让整个调试页面无意义重渲染。
 */
export function mergeTurnPages(
  existing: readonly api.TurnTrace[],
  incoming: readonly api.TurnTrace[],
): api.TurnTrace[] {
  const byId = new Map<string, api.TurnTrace>();
  const order: string[] = [];

  const absorb = (turn: api.TurnTrace) => {
    const prev = byId.get(turn.turnId);
    if (!prev) {
      byId.set(turn.turnId, turn);
      order.push(turn.turnId);
      return;
    }
    // 同 turnId：合并事件、去重、按 seq/timestamp 重排（还原追踪时间线）。
    const eventByKey = new Map<string, api.TraceEvent>();
    for (const event of [...prev.events, ...turn.events]) {
      const key = traceEventKey(event);
      // The newer window wins when an in-flight event is returned again with
      // the same identity but updated payload data.
      eventByKey.set(key, event);
    }
    const events = [...eventByKey.values()];
    events.sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.timestamp.localeCompare(b.timestamp),
    );
    byId.set(turn.turnId, {
      ...prev,
      startedAt: earlierTimestamp(prev.startedAt, turn.startedAt),
      completedAt: laterTimestamp(prev.completedAt, turn.completedAt),
      eventCount: events.length,
      events,
    });
  };

  for (const turn of existing) absorb(turn);
  for (const turn of incoming) absorb(turn);

  const merged = order
    .map((id) => byId.get(id) as api.TurnTrace)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const unchanged =
    merged.length === existing.length &&
    merged.every((turn, index) => {
      const previous = existing[index];
      return (
        previous !== undefined &&
        turn.turnId === previous.turnId &&
        turn.flowId === previous.flowId &&
        turn.traceId === previous.traceId &&
        turn.startedAt === previous.startedAt &&
        turn.completedAt === previous.completedAt &&
        turn.eventCount === previous.eventCount &&
        turn.events.length === previous.events.length &&
        turn.events.every((event, eventIndex) => {
          const previousEvent = previous.events[eventIndex];
          return (
            previousEvent !== undefined &&
            traceEventKey(event) === traceEventKey(previousEvent) &&
            JSON.stringify(event) === JSON.stringify(previousEvent)
          );
        })
      );
    });

  return unchanged ? (existing as api.TurnTrace[]) : merged;
}
