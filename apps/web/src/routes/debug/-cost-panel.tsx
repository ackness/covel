import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type * as api from "@/services/api.js";
import type { VisibleTurn } from "./-debug-page-model.js";

/**
 * Token usage panel — aggregates `usage` from the persisted `llm.responded` /
 * `gateway.responded` trace events (per runtime, per turn, session total).
 *
 * Aggregates generically by event type + runtimeId, never hardcoding a plugin
 * ID. USD cost conversion is intentionally NOT done here: `llm.responded`
 * payloads do not yet carry the model id, so `usage × pricing` would be
 * incomplete — that is a separate follow-up (thread model into the trace
 * payload, then sum via the server-side `resolveCapability` for a single
 * pricing source of truth).
 */

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function readUsage(event: api.TraceEvent): Usage | null {
  if (event.type !== "llm.responded" && event.type !== "gateway.responded") {
    return null;
  }
  const usage = (event.payload as Record<string, unknown>).usage as
    | { inputTokens?: number; outputTokens?: number }
    | undefined;
  if (!usage) return null;
  return {
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
  };
}

interface RuntimeAgg {
  readonly runtimeId: string;
  readonly pluginId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface TurnAgg {
  readonly turnIndex: number;
  readonly turnId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface CostModel {
  readonly totalCalls: number;
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly byRuntime: readonly RuntimeAgg[];
  readonly byTurn: readonly TurnAgg[];
}

export function aggregate(turns: readonly VisibleTurn[]): CostModel {
  const runtimeMap = new Map<string, RuntimeAgg>();
  const byTurn: TurnAgg[] = [];
  let totalCalls = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const { turn, turnIndex } of turns) {
    let turnCalls = 0;
    let turnInput = 0;
    let turnOutput = 0;
    for (const event of turn.events) {
      const usage = readUsage(event);
      if (!usage) continue;
      const payload = event.payload as Record<string, unknown>;
      const runtimeId = (payload.runtimeId as string) || "(unknown)";
      const pluginId = (payload.pluginId as string) || "";
      // Immutable accumulate: replace the map entry with a fresh object
      // rather than mutating the stored one in place.
      const prev = runtimeMap.get(runtimeId);
      runtimeMap.set(runtimeId, {
        runtimeId,
        pluginId: prev?.pluginId || pluginId,
        calls: (prev?.calls ?? 0) + 1,
        inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
      });
      turnCalls += 1;
      turnInput += usage.inputTokens;
      turnOutput += usage.outputTokens;
      totalCalls += 1;
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
    }
    if (turnCalls > 0) {
      byTurn.push({
        turnIndex,
        turnId: turn.turnId,
        calls: turnCalls,
        inputTokens: turnInput,
        outputTokens: turnOutput,
      });
    }
  }

  const byRuntime = [...runtimeMap.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  return { totalCalls, totalInput, totalOutput, byRuntime, byTurn };
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border border-[var(--rule-color)] px-3 py-2 min-w-[7rem]">
      <span className="ui-meta text-[9px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="font-mono text-base tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

export function CostPanel({ turns }: { turns: readonly VisibleTurn[] }) {
  const { t } = useTranslation();
  const model = useMemo(() => aggregate(turns), [turns]);
  const totalTokens = model.totalInput + model.totalOutput;
  const maxRuntimeTokens = Math.max(
    1,
    ...model.byRuntime.map((r) => r.inputTokens + r.outputTokens),
  );

  if (model.totalCalls === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        {t("debugger.cost.noData", "No token usage recorded for this session.")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-6">
      {/* Session totals */}
      <section className="space-y-2">
        <h2 className="ui-meta text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("debugger.cost.session", "Session total")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <StatCard
            label={t("debugger.cost.totalTokens", "Total tokens")}
            value={fmt(totalTokens)}
          />
          <StatCard
            label={t("debugger.cost.input", "Input")}
            value={fmt(model.totalInput)}
          />
          <StatCard
            label={t("debugger.cost.output", "Output")}
            value={fmt(model.totalOutput)}
          />
          <StatCard
            label={t("debugger.cost.calls", "LLM calls")}
            value={fmt(model.totalCalls)}
          />
        </div>
        <p className="ui-meta text-[9px] text-muted-foreground/70">
          {t(
            "debugger.cost.note",
            "Token sums from llm.responded / gateway.responded. USD cost is a pending follow-up (model id not yet in the trace payload).",
          )}
        </p>
      </section>

      {/* By runtime */}
      <section className="space-y-2">
        <h2 className="ui-meta text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("debugger.cost.byRuntime", "By runtime")}
        </h2>
        <div className="space-y-1.5">
          {model.byRuntime.map((r) => {
            const tokens = r.inputTokens + r.outputTokens;
            const pct = Math.round((tokens / maxRuntimeTokens) * 100);
            return (
              <div key={r.runtimeId} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="font-mono truncate text-foreground">
                    {r.runtimeId}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                    {fmt(tokens)} · {r.calls}×
                  </span>
                </div>
                <div className="h-1.5 w-full bg-[var(--surface-inset)] overflow-hidden">
                  <div
                    className="h-full bg-primary/60"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* By turn */}
      <section className="space-y-2">
        <h2 className="ui-meta text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("debugger.cost.byTurn", "By turn")}
        </h2>
        <div className="border border-[var(--rule-color)] divide-y divide-[var(--rule-color)]">
          {model.byTurn.map((tn) => (
            <div
              key={tn.turnId}
              className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[11px]"
            >
              <span className="font-mono text-foreground">
                {t("debugger.turn", { count: tn.turnIndex })}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {fmt(tn.inputTokens)} → {fmt(tn.outputTokens)} ·{" "}
                {fmt(tn.inputTokens + tn.outputTokens)} · {tn.calls}×
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
