/**
 * SessionPrep — pre-game preparation screen.
 *
 * Presents the plugin orchestration flow before the game starts:
 * start node → Pre-Game band → Core-Game-Loop band.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  BookOpenText,
  Bot,
  Check,
  CircleDot,
  Cpu,
  FileCode2,
  Globe,
  Link2,
  Play,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TimerReset,
  Trash2,
  Wrench,
} from "lucide-react";
import * as api from "@/services/api.js";
import type {
  PluginDocEntry,
  PluginDocsResponse,
  PluginFlowResponse,
  PluginFlowSegment,
  PluginFlowStep,
  PluginInfo,
} from "@/services/api.js";
import type { WorldRecord, SessionRecord } from "@/stores/session-store.js";

const AUTO_REFRESH_MS = 2000;

interface SessionPrepProps {
  world: WorldRecord;
  plugins: PluginInfo[];
  selectedPlugins: string[];
  pluginFlow: PluginFlowResponse | null;
  worldSessions: SessionRecord[];
  onStart: () => void;
  onBack: () => void;
  onResume: (sessionId: string, worldId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePlugin: (pluginName: string) => void;
  onRefreshPlugins: () => void | Promise<void>;
}

interface PositionedStep extends PluginFlowStep {
  leftPct: number;
  lane: number;
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    init: "初始化",
    character_creation: "角色创建",
    playing: "游戏中",
    ended: "已结束",
  };
  return map[phase] ?? phase;
}

function sessionShortId(id: string): string {
  const parts = id.split("-");
  return parts.at(-1) ?? id.slice(-8);
}

function textValue(value: string | Record<string, string> | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value["zh-CN"] ?? value.zh ?? value["en-US"] ?? value.en ?? Object.values(value)[0] ?? "";
}

function triggerSummary(step: PluginFlowStep): string {
  const parts = [step.trigger.type];
  if (step.trigger.interval != null) parts.push(`每${step.trigger.interval}轮`);
  if (step.trigger.cooldownTurns != null) parts.push(`冷却${step.trigger.cooldownTurns}`);
  if (step.trigger.maxTriggerCount != null) parts.push(`上限${step.trigger.maxTriggerCount}`);
  if (step.trigger.phases.length > 0) parts.push(step.trigger.phases.join(" / "));
  return parts.join(" · ");
}

function segmentTone(segmentId: PluginFlowStep["segmentId"] | "start"): {
  frame: string;
  glow: string;
  rail: string;
  label: string;
} {
  if (segmentId === "pre-game") {
    return {
      frame: "border-amber-300/70 bg-[linear-gradient(135deg,rgba(255,247,237,0.94),rgba(255,255,255,0.85))] dark:border-amber-700/50 dark:bg-[linear-gradient(135deg,rgba(52,32,11,0.82),rgba(24,24,27,0.92))]",
      glow: "shadow-[0_18px_55px_-30px_rgba(217,119,6,0.55)]",
      rail: "from-amber-300 via-orange-400 to-amber-200 dark:from-amber-700 dark:via-orange-500 dark:to-amber-500",
      label: "text-amber-700 dark:text-amber-300",
    };
  }
  if (
    segmentId === "pre-narrator" ||
    segmentId === "narrator" ||
    segmentId === "post-narrator"
  ) {
    return {
      frame: "border-sky-300/70 bg-[linear-gradient(135deg,rgba(239,246,255,0.92),rgba(255,255,255,0.82))] dark:border-sky-700/50 dark:bg-[linear-gradient(135deg,rgba(8,47,73,0.5),rgba(24,24,27,0.92))]",
      glow: "shadow-[0_18px_55px_-30px_rgba(2,132,199,0.55)]",
      rail: "from-sky-400 via-cyan-400 to-blue-300 dark:from-sky-700 dark:via-cyan-500 dark:to-blue-500",
      label: "text-sky-700 dark:text-sky-300",
    };
  }
  return {
    frame: "border-zinc-300/70 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(244,244,245,0.88))] dark:border-zinc-700/80 dark:bg-[linear-gradient(135deg,rgba(24,24,27,0.95),rgba(39,39,42,0.92))]",
    glow: "shadow-[0_20px_50px_-34px_rgba(24,24,27,0.7)]",
    rail: "from-zinc-300 via-zinc-500 to-zinc-200 dark:from-zinc-700 dark:via-zinc-500 dark:to-zinc-600",
    label: "text-zinc-700 dark:text-zinc-300",
  };
}

function layoutSegmentSteps(
  steps: PluginFlowStep[],
  segment: PluginFlowSegment,
): PositionedStep[] {
  const range = Math.max(1, segment.maxPriority - segment.minPriority);
  const laneOccupancy: number[] = [];

  return [...steps]
    .sort((a, b) => a.priority - b.priority || a.runtimeId.localeCompare(b.runtimeId))
    .map((step) => {
      const normalized = ((step.priority - segment.minPriority) / range) * 100;
      const leftPct = Math.max(8, Math.min(92, normalized));
      const threshold = step.isStoryRuntime ? 19 : 14;
      let lane = 0;

      while (laneOccupancy[lane] != null && leftPct - laneOccupancy[lane] < threshold) {
        lane += 1;
      }
      laneOccupancy[lane] = leftPct;

      return {
        ...step,
        leftPct,
        lane,
      };
    });
}

function formatGeneratedAt(value: string | undefined): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return value;
  }
}

function preferredRuntime(steps: PluginFlowStep[]): PluginFlowStep | null {
  return steps.find((step) => step.isStoryRuntime) ?? steps[0] ?? null;
}

function RuntimeChip({
  step,
  active,
  onSelect,
}: {
  step: PluginFlowStep;
  active: boolean;
  onSelect: (step: PluginFlowStep) => void;
}) {
  const storyRuntimeClasses = step.isStoryRuntime
    ? "border-emerald-400/70 bg-[linear-gradient(135deg,rgba(16,185,129,0.22),rgba(255,255,255,0.97))] dark:bg-[linear-gradient(135deg,rgba(6,78,59,0.8),rgba(20,20,24,0.96))] shadow-[0_22px_64px_-32px_rgba(16,185,129,0.72)]"
    : "border-zinc-300/70 bg-white/88 dark:border-zinc-700/80 dark:bg-zinc-950/75 shadow-[0_16px_36px_-30px_rgba(24,24,27,0.62)]";

  const activeClasses = active
    ? "ring-2 ring-sky-400/60 ring-offset-2 ring-offset-white/40 dark:ring-sky-500/70 dark:ring-offset-zinc-950/40"
    : "hover:border-zinc-400/80 hover:-translate-y-0.5 dark:hover:border-zinc-500/80";

  return (
    <button
      type="button"
      onClick={() => onSelect(step)}
      className={`group relative w-full rounded-[20px] border px-3.5 py-2.5 text-left transition-all ${storyRuntimeClasses} ${activeClasses}`}
    >
      <span className="absolute -top-8 left-1/2 h-8 w-px -translate-x-1/2 bg-zinc-300/90 dark:bg-zinc-700/80" />
      <span className={`absolute -top-10 left-1/2 h-5 w-5 -translate-x-1/2 rounded-full border-4 ${
        step.isStoryRuntime
          ? "border-emerald-500 bg-emerald-300 dark:border-emerald-400 dark:bg-emerald-500/70"
          : "border-sky-500 bg-sky-200 dark:border-sky-400 dark:bg-sky-500/60"
      }`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">
              {step.pluginName}
            </span>
            {step.isStoryRuntime && (
                  <span className="rounded-full bg-emerald-500/14 px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
                Story
              </span>
            )}
          </div>
          <div className="mt-1 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            {step.runtimeName}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[9px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
              P{step.priority}
            </span>
            <span className="rounded-full border border-zinc-300/80 px-2 py-0.5 text-[9px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
              {step.runtimeType}
            </span>
            <span className="rounded-full border border-zinc-300/80 px-2 py-0.5 text-[9px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
              {step.outputKind}
            </span>
          </div>
        </div>
        <BookOpenText className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-700 dark:group-hover:text-zinc-200" />
      </div>

      <p className="mt-2.5 line-clamp-2 text-[10px] leading-relaxed text-zinc-600 dark:text-zinc-300">
        {step.description}
      </p>

      <div className="mt-2.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[9px] text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <TimerReset className="h-3 w-3" />
          {triggerSummary(step)}
        </span>
        {step.injects.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3" />
            {step.injects.map((inject) => inject.from).join(", ")}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {step.model && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            model: {step.model}
          </span>
        )}
        {(step.tools.builtin.length > 0 || step.tools.local.length > 0) && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            tools: {step.tools.builtin.length + step.tools.local.length}
          </span>
        )}
        {step.uiSlots.length > 0 && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            ui: {step.uiSlots.join(", ")}
          </span>
        )}
      </div>
    </button>
  );
}

function FlowBand({
  segment,
  steps,
  activeRuntimeId,
  onSelect,
}: {
  segment: PluginFlowSegment;
  steps: PluginFlowStep[];
  activeRuntimeId: string | null;
  onSelect: (step: PluginFlowStep) => void;
}) {
  const tone = segmentTone(segment.id as PluginFlowStep["segmentId"]);
  const positioned = layoutSegmentSteps(steps, segment);
  const lanes = Math.max(1, ...positioned.map((step) => step.lane + 1));
  const desktopHeight = 126 + lanes * 142;
  const startLabel = segment.id === "pre-game" ? "0" : "100";
  const endLabel = segment.id === "pre-game" ? "100" : "1000";

  return (
    <section className={`relative overflow-hidden rounded-[28px] border p-5 ${tone.frame} ${tone.glow}`}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.7),transparent_42%)] dark:bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.06),transparent_42%)]" />
      <div className="relative flex items-end justify-between gap-4">
        <div>
          <div className={`text-[10px] font-semibold uppercase tracking-[0.28em] ${tone.label}`}>
            {segment.label}
          </div>
          <h3 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            Priority {segment.rangeLabel}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
            框架会先完成当前区间内的编排，再进入下一段。你现在看到的是固定格式化后的 runtime 视图。
          </p>
        </div>
        <div className="rounded-full border border-zinc-300/80 bg-white/75 px-3 py-1 text-[11px] font-medium text-zinc-600 backdrop-blur dark:border-zinc-700 dark:bg-zinc-950/50 dark:text-zinc-300">
          {steps.length} 个 runtime
        </div>
      </div>

      <div className="mt-6 rounded-[24px] border border-white/70 bg-white/55 p-4 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-950/35">
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500 dark:text-zinc-400">
          <span>{startLabel}</span>
          <span>{segment.rangeLabel}</span>
          <span>{endLabel}</span>
        </div>

        <div className="mt-4 lg:hidden">
          <div className={`h-px w-full bg-gradient-to-r ${tone.rail}`} />
          <div className="mt-4 space-y-3">
            {steps.map((step) => (
              <RuntimeChip
                key={step.runtimeId}
                step={step}
                active={step.runtimeId === activeRuntimeId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>

        <div className="relative mt-4 hidden lg:block" style={{ height: `${desktopHeight}px` }}>
          <div className={`absolute left-0 right-0 top-9 h-[2px] bg-gradient-to-r ${tone.rail}`} />
          <div className="absolute left-0 top-6 h-7 w-7 rounded-full border border-zinc-300 bg-white/90 text-[10px] font-semibold text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-950/85 dark:text-zinc-300">
            <div className="flex h-full items-center justify-center">{startLabel}</div>
          </div>
          <div className="absolute right-0 top-6 h-7 w-7 rounded-full border border-zinc-300 bg-white/90 text-[10px] font-semibold text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-950/85 dark:text-zinc-300">
            <div className="flex h-full items-center justify-center">{endLabel}</div>
          </div>

          {positioned.map((step) => (
            <div
              key={step.runtimeId}
              className={`absolute ${step.isStoryRuntime ? "w-[14.75rem]" : "w-[12.5rem]"}`}
              style={{
                left: `${step.leftPct}%`,
                top: `${44 + step.lane * 142}px`,
                transform: "translateX(-50%)",
              }}
            >
              <RuntimeChip
                step={step}
                active={step.runtimeId === activeRuntimeId}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PluginDocsPanel({
  step,
  docs,
  loading,
  error,
  onSelectRuntime,
}: {
  step: PluginFlowStep | null;
  docs: PluginDocEntry[];
  loading: boolean;
  error: string | null;
  onSelectRuntime: (runtimeId: string) => void;
}) {
  const activeDoc = step ? docs.find((doc) => doc.runtimeId === step.runtimeId) ?? docs[0] ?? null : null;

  return (
    <section className="relative overflow-hidden rounded-[28px] border border-zinc-200/80 bg-[linear-gradient(140deg,rgba(255,255,255,0.96),rgba(244,244,245,0.92))] p-5 shadow-[0_18px_55px_-34px_rgba(24,24,27,0.55)] dark:border-zinc-800 dark:bg-[linear-gradient(140deg,rgba(24,24,27,0.96),rgba(39,39,42,0.94))]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_36%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.1),transparent_36%)]" />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:text-zinc-400">
              Plugin.md Preview
            </div>
            <h3 className="mt-2 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {step ? `${step.pluginName} / ${step.runtimeName}` : "选择 runtime 查看文档"}
            </h3>
          </div>
          <div className="rounded-full border border-zinc-300/80 bg-white/75 p-2 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
            <FileCode2 className="h-4 w-4" />
          </div>
        </div>

        {step && (
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
              {step.runtimeId}
            </span>
            <span className="rounded-full border border-zinc-300/80 px-2.5 py-1 text-[10px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
              {step.docPath}
            </span>
          </div>
        )}

        {docs.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {docs.map((doc) => (
              <button
                key={doc.runtimeId}
                type="button"
                onClick={() => onSelectRuntime(doc.runtimeId)}
                className={`rounded-full border px-3 py-1 text-[10px] font-medium transition-colors ${
                  step?.runtimeId === doc.runtimeId
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 bg-white/75 text-zinc-600 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/55 dark:text-zinc-300 dark:hover:text-zinc-100"
                }`}
              >
                {doc.label.split("/").at(-1)}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 rounded-[22px] border border-zinc-200/80 bg-zinc-950 p-4 text-[12px] leading-6 text-zinc-200 dark:border-zinc-800">
          {loading && <div className="text-zinc-400">正在加载文档...</div>}
          {!loading && error && <div className="text-red-300">{error}</div>}
          {!loading && !error && !activeDoc && (
            <div className="text-zinc-400">点击流程图中的 runtime，即可预览对应的 PLUGIN.md。</div>
          )}
          {!loading && !error && activeDoc && (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-6 text-zinc-200 xl:max-h-[calc(100vh-18rem)]">
              {activeDoc.content}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}

export function SessionPrep({
  world,
  plugins,
  selectedPlugins,
  pluginFlow,
  worldSessions,
  onStart,
  onBack,
  onResume,
  onDelete,
  onTogglePlugin,
  onRefreshPlugins,
}: SessionPrepProps) {
  const docsPanelRef = useRef<HTMLDivElement | null>(null);
  const [focusedRuntimeId, setFocusedRuntimeId] = useState<string | null>(null);
  const [docsByPlugin, setDocsByPlugin] = useState<Record<string, PluginDocsResponse>>({});
  const [docLoadingPluginId, setDocLoadingPluginId] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  const activeSteps = pluginFlow?.steps.filter((step) => selectedPlugins.includes(step.pluginId)) ?? [];
  const startSegment = pluginFlow?.segments.find((segment) => segment.id === "start") ?? null;
  const preGameSegment = pluginFlow?.segments.find((segment) => segment.id === "pre-game") ?? null;
  const CORE_SEGMENT_IDS = ["pre-narrator", "narrator", "post-narrator"] as const;
  const coreSubSegments = pluginFlow?.segments.filter((segment) =>
    (CORE_SEGMENT_IDS as readonly string[]).includes(segment.id),
  ) ?? [];
  const coreSegment: PluginFlowSegment | null = coreSubSegments.length
    ? ({
        id: "post-narrator",
        label: "Core-Game-Loop",
        rangeLabel: `${coreSubSegments[0]!.minPriority}-${coreSubSegments[coreSubSegments.length - 1]!.maxPriority}`,
        minPriority: coreSubSegments[0]!.minPriority,
        maxPriority: coreSubSegments[coreSubSegments.length - 1]!.maxPriority,
      } satisfies PluginFlowSegment)
    : null;
  const activeRuntime = activeSteps.find((step) => step.runtimeId === focusedRuntimeId) ?? preferredRuntime(activeSteps);
  const previewDocs = activeRuntime ? docsByPlugin[activeRuntime.pluginId]?.docs ?? [] : [];
  const runtimeCountByPlugin = new Map(
    (pluginFlow?.plugins ?? []).map((plugin) => [plugin.id, plugin.runtimeIds.length]),
  );

  useEffect(() => {
    if (!activeRuntime && focusedRuntimeId) {
      setFocusedRuntimeId(null);
    }
  }, [activeRuntime, focusedRuntimeId]);

  useEffect(() => {
    void Promise.resolve(onRefreshPlugins());

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void Promise.resolve(onRefreshPlugins());
    }, AUTO_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [onRefreshPlugins]);

  useEffect(() => {
    if (!activeRuntime) return;
    const pluginId = activeRuntime.pluginId;

    let cancelled = false;

    async function loadDocs(force = false) {
      if (!force && docsByPlugin[pluginId]) return;

      try {
        setDocLoadingPluginId(pluginId);
        setDocError(null);
        const response = await api.fetchPluginDocs(pluginId);
        if (cancelled) return;
        setDocsByPlugin((current) => ({ ...current, [pluginId]: response }));
      } catch (error) {
        if (cancelled) return;
        setDocError((error as Error).message);
      } finally {
        if (!cancelled) setDocLoadingPluginId(null);
      }
    }

    void loadDocs();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void loadDocs(true);
    }, AUTO_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRuntime, docsByPlugin]);

  const preGameSteps = activeSteps.filter((step) => step.segmentId === "pre-game");
  const coreSteps = activeSteps.filter((step) =>
    (CORE_SEGMENT_IDS as readonly string[]).includes(step.segmentId),
  );

  function focusRuntime(step: PluginFlowStep) {
    setFocusedRuntimeId(step.runtimeId);

    if (typeof window !== "undefined" && window.innerWidth < 1280) {
      window.requestAnimationFrame(() => {
        docsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  return (
    <div className="min-h-full overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.08),transparent_22%)] py-8 dark:bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.08),transparent_22%)]">
      <div className="mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300/80 bg-white/80 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回选择世界
          </button>
          <button
            type="button"
            onClick={() => void Promise.resolve(onRefreshPlugins())}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300/80 bg-white/80 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            热刷新
          </button>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.86fr)]">
          <div className="space-y-5">
            <section className="relative overflow-hidden rounded-[32px] border border-zinc-200/80 bg-[linear-gradient(145deg,rgba(255,255,255,0.98),rgba(244,244,245,0.94))] p-6 shadow-[0_28px_80px_-38px_rgba(24,24,27,0.58)] dark:border-zinc-800 dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.97),rgba(39,39,42,0.95))]">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.12),transparent_24%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.12),transparent_24%)]" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-zinc-300/80 bg-white/75 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-400">
                    <Sparkles className="h-3.5 w-3.5" />
                    Plugin Orchestration Preview
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <div className="rounded-2xl bg-zinc-900 p-3 text-white dark:bg-zinc-100 dark:text-zinc-900">
                      <Globe className="h-5 w-5" />
                    </div>
                    <div>
                      <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 lg:text-4xl">
                        {textValue(world.name)}
                      </h1>
                      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                        {world.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {world.tags?.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-zinc-300/80 bg-white/80 px-2.5 py-1 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300"
                      >
                        {tag}
                      </span>
                    ))}
                    {pluginFlow && (
                      <span className="rounded-full border border-zinc-300/80 bg-white/80 px-2.5 py-1 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
                        编排版本 {pluginFlow.version} · {formatGeneratedAt(pluginFlow.generatedAt)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 lg:w-[26rem]">
                  <div className="rounded-[22px] border border-zinc-300/80 bg-white/78 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">Selected</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
                      {selectedPlugins.length}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">启用插件</div>
                  </div>
                  <div className="rounded-[22px] border border-zinc-300/80 bg-white/78 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">Pre-Game</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
                      {preGameSteps.length}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">首轮 runtime</div>
                  </div>
                  <div className="rounded-[22px] border border-zinc-300/80 bg-white/78 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 dark:text-zinc-400">Core Loop</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
                      {coreSteps.length}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">循环 runtime</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="relative overflow-hidden rounded-[28px] border border-zinc-200/80 bg-[linear-gradient(145deg,rgba(255,255,255,0.96),rgba(244,244,245,0.93))] p-5 shadow-[0_18px_55px_-34px_rgba(24,24,27,0.55)] dark:border-zinc-800 dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(39,39,42,0.94))]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:text-zinc-400">
                    Plugin Selection
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
                    选择参与编排的插件
                  </h3>
                </div>
                <div className="rounded-full border border-zinc-300/80 bg-white/75 px-3 py-1 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
                  {selectedPlugins.length}/{plugins.length}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {plugins.map((plugin) => {
                  const selected = selectedPlugins.includes(plugin.name);
                  const locked = plugin.pluginType === "core-plugin";
                  const runtimeCount = runtimeCountByPlugin.get(plugin.name) ?? 0;
                  return (
                    <button
                      key={plugin.name}
                      type="button"
                      onClick={() => onTogglePlugin(plugin.name)}
                      disabled={locked}
                      className={`rounded-[22px] border px-4 py-3 text-left transition-all ${
                        selected
                          ? "border-zinc-900 bg-zinc-900 text-white shadow-[0_18px_40px_-24px_rgba(24,24,27,0.78)] dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-300/80 bg-white/82 text-zinc-700 hover:-translate-y-0.5 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-200"
                      } ${locked ? "cursor-default" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            selected
                              ? "border-white/60 bg-white/14 text-white dark:border-zinc-900/60 dark:bg-zinc-900/14 dark:text-zinc-900"
                              : "border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500"
                          }`}>
                            {selected ? <Check className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold">
                                {textValue(plugin.displayName) || plugin.name}
                              </span>
                              {locked && (
                                <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] ${
                                  selected
                                    ? "bg-white/14 text-white/90 dark:bg-zinc-900/14 dark:text-zinc-900"
                                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-300"
                                }`}>
                                  Core
                                </span>
                              )}
                            </div>
                            <p className={`mt-1 text-[11px] leading-relaxed ${
                              selected ? "text-white/80 dark:text-zinc-800" : "text-zinc-500 dark:text-zinc-400"
                            }`}>
                              {textValue(plugin.description)}
                            </p>
                          </div>
                        </div>
                        <div className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          selected
                            ? "bg-white/14 text-white dark:bg-zinc-900/14 dark:text-zinc-900"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-300"
                        }`}>
                          {runtimeCount} rt
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className={`relative overflow-hidden rounded-[30px] border p-6 ${segmentTone("start").frame} ${segmentTone("start").glow}`}>
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.55),transparent_42%)] dark:bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.05),transparent_42%)]" />
              <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-2xl">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:text-zinc-400">
                    {startSegment?.label ?? "开始游戏"}
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <div className="rounded-[22px] bg-zinc-900 p-4 text-white dark:bg-zinc-100 dark:text-zinc-900">
                      <Play className="h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
                        Start Game · 0
                      </h2>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                        会话从这里启动，框架按照固定的 priority 区间推进到 Pre-Game，再进入 Core-Game-Loop。
                      </p>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onStart}
                  className="inline-flex items-center justify-center gap-2 rounded-[22px] bg-zinc-950 px-6 py-4 text-sm font-semibold text-white shadow-[0_18px_38px_-20px_rgba(24,24,27,0.8)] transition-transform hover:-translate-y-0.5 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  <Play className="h-4 w-4" />
                  开始新游戏
                </button>
              </div>
            </section>

            <div className="flex items-center justify-center py-1 text-zinc-400 dark:text-zinc-600">
              <ArrowDown className="h-5 w-5" />
            </div>

            {preGameSegment && (
              <FlowBand
                segment={preGameSegment}
                steps={preGameSteps}
                activeRuntimeId={activeRuntime?.runtimeId ?? null}
                onSelect={focusRuntime}
              />
            )}

            <div className="flex items-center justify-center py-1 text-zinc-400 dark:text-zinc-600">
              <ArrowDown className="h-5 w-5" />
            </div>

            {coreSegment && (
              <FlowBand
                segment={coreSegment}
                steps={coreSteps}
                activeRuntimeId={activeRuntime?.runtimeId ?? null}
                onSelect={focusRuntime}
              />
            )}
          </div>

          <div className="space-y-5">
            <section className="rounded-[28px] border border-zinc-200/80 bg-[linear-gradient(145deg,rgba(255,255,255,0.96),rgba(244,244,245,0.93))] p-5 shadow-[0_18px_55px_-34px_rgba(24,24,27,0.55)] dark:border-zinc-800 dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(39,39,42,0.94))]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:text-zinc-400">
                    Session Archive
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
                    历史存档
                  </h3>
                </div>
                <div className="rounded-full border border-zinc-300/80 bg-white/75 px-3 py-1 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
                  {worldSessions.length}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {worldSessions.length === 0 && (
                  <div className="rounded-[22px] border border-dashed border-zinc-300/80 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    当前世界还没有历史存档。
                  </div>
                )}

                {worldSessions.map((session) => (
                  <div
                    key={session.id}
                    className="rounded-[22px] border border-zinc-300/80 bg-white/85 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-950/55"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-mono text-zinc-600 dark:text-zinc-300">
                            #{sessionShortId(session.id)}
                          </span>
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:bg-zinc-900 dark:text-zinc-300">
                            {phaseLabel(session.phase)}
                          </span>
                          {session.embedding ? (
                            <span
                              className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[9px] font-medium text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/35 dark:text-emerald-300"
                              title={`${session.embedding.modelId} · ${session.embedding.dim}d`}
                            >
                              RAG · {session.embedding.modelName}
                            </span>
                          ) : null}
                        </div>
                        {session.createdAt && (
                          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {new Date(session.createdAt).toLocaleString("zh-CN", {
                              month: "numeric",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onResume(session.id, world.id)}
                          className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-3 py-1.5 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-950/35 dark:text-sky-300"
                        >
                          <RotateCcw className="h-3 w-3" />
                          继续
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(session.id)}
                          className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                        >
                          <Trash2 className="h-3 w-3" />
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[28px] border border-zinc-200/80 bg-[linear-gradient(145deg,rgba(255,255,255,0.96),rgba(244,244,245,0.93))] p-5 shadow-[0_18px_55px_-34px_rgba(24,24,27,0.55)] dark:border-zinc-800 dark:bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(39,39,42,0.94))]">
              <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500 dark:text-zinc-400">
                Readout
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-3 rounded-[22px] border border-zinc-300/80 bg-white/82 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">主叙事 runtime</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      负责主叙事输出的 runtime 会单独高亮。点击高亮节点可以直接预览它的 PLUGIN.md。
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-[22px] border border-zinc-300/80 bg-white/82 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                  <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div>
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">工具与注入</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      每个 runtime 卡片会同时展示 trigger、输入注入、工具数量和 UI 输出位置，方便你在开局前检查链路。
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-[22px] border border-zinc-300/80 bg-white/82 p-4 dark:border-zinc-700 dark:bg-zinc-950/55">
                  <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
                  <div>
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">热刷新</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      页面会按 2 秒周期重新读取插件流程和文档内容，编排预览会跟随 frontmatter 变化即时更新。
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onStart}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[22px] bg-zinc-950 px-4 py-4 text-sm font-semibold text-white shadow-[0_18px_38px_-20px_rgba(24,24,27,0.8)] transition-transform hover:-translate-y-0.5 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  <Play className="h-4 w-4" />
                  以当前编排开始游戏
                </button>
              </div>
            </section>

            <div ref={docsPanelRef}>
              <PluginDocsPanel
                step={activeRuntime}
                docs={previewDocs}
                loading={docLoadingPluginId === activeRuntime?.pluginId}
                error={docError}
                onSelectRuntime={setFocusedRuntimeId}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
