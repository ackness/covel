import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getProviderPriceMultiplier,
  lookupModelCapability,
} from "@/services/api.js";
import type * as api from "@/services/api.js";
import type { VisibleTurn } from "./-debug-page-model.js";

/**
 * Token usage + estimated cost panel — aggregates `usage` from the persisted
 * `llm.responded` / `gateway.responded` trace events (per runtime, per turn,
 * per model, session total).
 *
 * Aggregates generically by event type + runtimeId, never hardcoding a plugin
 * ID. Model attribution: `llm.responded` payloads carry no model id, so each
 * usage event is paired with the most recent `llm.calling` for the same
 * runtimeId within the turn (events are stored in emission order, and
 * calling/responded always pair up per call). `gateway.responded` carries a
 * slot (presetId), not a model — its usage stays unattributed and is excluded
 * from pricing, making the USD figure a lower bound when present.
 *
 * Pricing comes from `/api/model-db/lookup` (LiteLLM-derived per-M-token
 * prices) via the existing `lookupModelCapability` service.
 */

/** Sentinel for usage that cannot be attributed to a concrete model id. */
export const UNKNOWN_MODEL = "(unknown)";

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function readUsage(event: api.TraceEvent): Usage | null {
  if (event.type !== "llm.responded" && event.type !== "gateway.responded") {
    return null;
  }
  const usage = (event.payload as Record<string, unknown>).usage as
    { inputTokens?: number; outputTokens?: number } | undefined;
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

interface ModelAgg {
  readonly model: string;
  readonly provider?: string;
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
  readonly byModel: readonly ModelAgg[];
}

export function aggregate(turns: readonly VisibleTurn[]): CostModel {
  const runtimeMap = new Map<string, RuntimeAgg>();
  const modelMap = new Map<string, ModelAgg>();
  const byTurn: TurnAgg[] = [];
  let totalCalls = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const { turn, turnIndex } of turns) {
    let turnCalls = 0;
    let turnInput = 0;
    let turnOutput = 0;
    // Sequential pairing: remember the model announced by the latest
    // `llm.calling` per runtime so the next `llm.responded` inherits it.
    const lastTargetByRuntime = new Map<
      string,
      { model: string; provider?: string }
    >();
    for (const event of turn.events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "llm.calling") {
        const rid = payload.runtimeId as string | undefined;
        const mdl = payload.model as string | undefined;
        const provider = payload.provider as string | undefined;
        if (rid && mdl) {
          lastTargetByRuntime.set(rid, {
            model: mdl,
            ...(provider ? { provider } : {}),
          });
        }
        continue;
      }
      const usage = readUsage(event);
      if (!usage) continue;
      const runtimeId = (payload.runtimeId as string) || "(unknown)";
      const pluginId = (payload.pluginId as string) || "";
      const target =
        event.type === "llm.responded"
          ? lastTargetByRuntime.get(runtimeId)
          : undefined;
      const model = target?.model ?? UNKNOWN_MODEL;
      const modelKey = `${target?.provider ?? ""}\u0000${model}`;
      const prevModel = modelMap.get(modelKey);
      modelMap.set(modelKey, {
        model,
        ...(target?.provider ? { provider: target.provider } : {}),
        calls: (prevModel?.calls ?? 0) + 1,
        inputTokens: (prevModel?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prevModel?.outputTokens ?? 0) + usage.outputTokens,
      });
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
  const byModel = [...modelMap.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  return { totalCalls, totalInput, totalOutput, byRuntime, byTurn, byModel };
}

// ── Pricing ──────────────────────────────────────────────────────

interface ModelPrice {
  readonly inputPerMToken?: number;
  readonly outputPerMToken?: number;
}

/** Module-level lookup cache — model prices don't change within a page visit. */
const priceCache = new Map<string, Promise<ModelPrice | null>>();

function lookupPrice(
  model: string,
  provider?: string,
): Promise<ModelPrice | null> {
  const key = `${provider ?? ""}\u0000${model}`;
  const cached = priceCache.get(key);
  if (cached) return cached;
  const promise = lookupModelCapability(model, provider)
    .then((cap) =>
      cap &&
      (cap.inputPerMToken !== undefined || cap.outputPerMToken !== undefined)
        ? {
            ...(cap.inputPerMToken !== undefined
              ? { inputPerMToken: cap.inputPerMToken }
              : {}),
            ...(cap.outputPerMToken !== undefined
              ? { outputPerMToken: cap.outputPerMToken }
              : {}),
          }
        : null,
    )
    .catch(() => null);
  priceCache.set(key, promise);
  return promise;
}

/** Resolve per-M-token prices for the given models (null = no pricing data). */
function useModelPrices(
  models: readonly ModelAgg[],
): Record<string, ModelPrice | null> {
  const [prices, setPrices] = useState<Record<string, ModelPrice | null>>({});
  useEffect(() => {
    let cancelled = false;
    const missing = models.filter((model) => {
      const key = `${model.provider ?? ""}\u0000${model.model}`;
      return model.model !== UNKNOWN_MODEL && !(key in prices);
    });
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (model) => {
        const key = `${model.provider ?? ""}\u0000${model.model}`;
        return [key, await lookupPrice(model.model, model.provider)] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPrices((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [models, prices]);
  return prices;
}

export function estimateCostUsd(
  agg: Pick<ModelAgg, "inputTokens" | "outputTokens">,
  price: ModelPrice,
  multiplier = 1,
): number {
  return (
    multiplier *
    ((agg.inputTokens / 1_000_000) * (price.inputPerMToken ?? 0) +
      (agg.outputTokens / 1_000_000) * (price.outputPerMToken ?? 0))
  );
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

export function CostPanel({
  turns,
  isPartial = false,
  onLoadAll,
}: {
  turns: readonly VisibleTurn[];
  // 仍有更早未加载的事件：下方聚合只是「当前窗口」，不是整会话合计。
  isPartial?: boolean;
  onLoadAll?: () => void;
}) {
  const { t } = useTranslation();
  const model = useMemo(() => aggregate(turns), [turns]);
  const totalTokens = model.totalInput + model.totalOutput;
  const maxRuntimeTokens = Math.max(
    1,
    ...model.byRuntime.map((r) => r.inputTokens + r.outputTokens),
  );
  const prices = useModelPrices(model.byModel);
  const cost = useMemo(() => {
    let usd = 0;
    let pricedTokens = 0;
    let unpricedTokens = 0;
    for (const agg of model.byModel) {
      const priceKey = `${agg.provider ?? ""}\u0000${agg.model}`;
      const price = agg.model === UNKNOWN_MODEL ? null : prices[priceKey];
      const tokens = agg.inputTokens + agg.outputTokens;
      if (price) {
        usd += estimateCostUsd(
          agg,
          price,
          getProviderPriceMultiplier(agg.provider),
        );
        pricedTokens += tokens;
      } else {
        unpricedTokens += tokens;
      }
    }
    return { usd, pricedTokens, unpricedTokens };
  }, [model.byModel, prices]);

  if (model.totalCalls === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        {t("debugger.cost.noData", "No token usage recorded for this session.")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-6">
      {/* 聚合合计：窗口化后标题明确「当前窗口」而非「会话合计」，避免静默失真 */}
      <section className="space-y-2">
        <h2 className="ui-meta text-[10px] uppercase tracking-wider text-muted-foreground">
          {isPartial
            ? t("debugger.cost.windowTitle", "Loaded window")
            : t("debugger.cost.session", "Session total")}
        </h2>
        {isPartial && (
          <div className="flex flex-wrap items-center gap-2 border border-amber-500/40 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
            <span>
              {t(
                "debugger.cost.partialNote",
                "Only the most recent window is loaded — totals below are partial.",
              )}
            </span>
            {onLoadAll && (
              <button
                type="button"
                onClick={onLoadAll}
                className="underline underline-offset-2 hover:opacity-80"
              >
                {t(
                  "debugger.cost.loadAllForTotal",
                  "Load all to include the full session",
                )}
              </button>
            )}
          </div>
        )}
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
          {cost.pricedTokens > 0 && (
            <StatCard
              label={t("debugger.cost.estCost", "Est. cost (USD)")}
              value={`${cost.unpricedTokens > 0 ? "≥ " : "≈ "}$${cost.usd.toFixed(4)}`}
            />
          )}
        </div>
        <p className="ui-meta text-[9px] text-muted-foreground/70">
          {t(
            "debugger.cost.note",
            "Token sums from llm.responded / gateway.responded. USD cost estimated from model-db prices; usage without a model id or price is excluded (cost shown as a lower bound).",
          )}
        </p>
      </section>

      {/* By model */}
      {model.byModel.length > 0 && (
        <section className="space-y-2">
          <h2 className="ui-meta text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("debugger.cost.byModel", "By model")}
          </h2>
          <div className="border border-[var(--rule-color)] divide-y divide-[var(--rule-color)]">
            {model.byModel.map((m) => {
              const priceKey = `${m.provider ?? ""}\u0000${m.model}`;
              const price = m.model === UNKNOWN_MODEL ? null : prices[priceKey];
              const multiplier = getProviderPriceMultiplier(m.provider);
              return (
                <div
                  key={priceKey}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[11px]"
                >
                  <span className="font-mono truncate text-foreground">
                    {m.model === UNKNOWN_MODEL
                      ? t("debugger.cost.unknownModel", "(unknown model)")
                      : `${m.provider ? `${m.provider} · ` : ""}${m.model}`}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                    {fmt(m.inputTokens)} → {fmt(m.outputTokens)} · {m.calls}× ·{" "}
                    {price
                      ? `$${estimateCostUsd(m, price, multiplier).toFixed(4)}${multiplier !== 1 ? ` (×${multiplier})` : ""}`
                      : t("debugger.cost.noPrice", "no price")}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

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
