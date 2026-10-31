/**
 * Helpers that wire the HookPipeline into turn-executor.ts call sites.
 *
 * Plugin hook handlers are registered by plugin entries. The pipeline itself
 * is the on/off gate: when callers pass `pipeline: undefined`
 * (e.g. CLI tools that don't want hooks), all helpers short-circuit
 * to a no-op continue so the non-hook path stays byte-for-byte identical.
 *
 * Keeping these helpers here lets us extract pipeline-plumbing boilerplate
 * and HookContext construction out of turn-executor.ts to keep it
 * under the 1000-line budget.
 *
 * Boilerplate convergence: every helper used to repeat the same
 * `if (!opts.pipeline) … pipeline.run(event, { event, sessionId, turnId, … },
 * payload, { eventBus, emitter })` block. That plumbing now lives once in
 * `runHook()` (+ `buildHookCtx`/`hookReplace`); each helper only keeps its
 * distinct *result interpretation*. The four observe-only events that share an
 * identical shape are produced by the generic `makeObserveHook` factory. The
 * HookPipeline engine itself (semantic dispatch, enforce ordering, per-handler
 * timeout, session-scope filtering) is untouched — see `./pipeline.ts`.
 */

import { isDeepStrictEqual } from "node:util";
import type { EventBus } from "@covel/events";
import type {
  InputSlot,
  RuntimeManifest,
  RuntimeResult,
  TurnAction,
  TurnInput,
} from "@covel/shared";
import type { HookPipeline } from "./pipeline.js";
import { cloneHookData } from "./hook-data.js";
import type { HookContext, HookEvent, HookResult } from "./types.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import type { LLMMessage, LLMResponse, LLMToolDefinition } from "@covel/shared";

// ── Shared options ───────────────────────────────────────────────

interface BaseOpts {
  readonly signal?: AbortSignal;
  readonly pipeline: HookPipeline | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
}

/**
 * Identity of the runtime an event is about. It goes into the HookContext
 * and nowhere else, so a handler finds it at `ctx.pluginId` / `ctx.runtimeId`
 * for every event.
 */
interface HookCtxExtra {
  readonly pluginId?: string;
  readonly runtimeId?: string;
}

// ── Pipeline plumbing (single source of the run() boilerplate) ───

/** Build the per-call HookContext from the shared options + event identity. */
function buildHookCtx(
  opts: BaseOpts,
  event: HookEvent,
  extra?: HookCtxExtra,
): HookContext {
  return {
    event,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    signal: opts.signal,
    ...extra,
  };
}

/**
 * Run the pipeline for `event` with a freshly-built HookContext, or return
 * `undefined` when the caller opted out of hooks (`pipeline: undefined`).
 *
 * This is the one place that constructs the HookContext and forwards
 * eventBus/emitter, so the no-op gate and the `pipeline.run(...)` call stay
 * byte-identical across every event.
 */
async function runHook<P>(
  opts: BaseOpts,
  event: HookEvent,
  payload: P,
  extra?: HookCtxExtra,
): Promise<HookResult<P> | undefined> {
  if (!opts.pipeline) return undefined;
  return opts.pipeline.run(event, buildHookCtx(opts, event, extra), payload, {
    eventBus: opts.eventBus,
    emitter: opts.emitter,
  });
}

/**
 * Extract the accumulated `replace` patch from a sequential hook result, or
 * `undefined` when the pipeline was absent or no handler rewrote the payload.
 */
function hookReplace<P>(
  result: HookResult<P> | undefined,
): Partial<P> | undefined {
  if (result && result.action === "continue" && "replace" in result) {
    return result.replace;
  }
  return undefined;
}

/**
 * Factory for observe-only wire-helpers — the parallel, fire-and-forget events
 * whose (continue-only) result carries no payload rewrite. SessionStart /
 * SessionEnd / TurnStop / PostCompaction share this exact shape and differ only
 * in event name + payload type, so one generic factory replaces four
 * near-identical bodies with zero behaviour change.
 */
function makeObserveHook<P>(
  event: HookEvent,
): (opts: BaseOpts, payload: P) => Promise<void> {
  return async (opts, payload) => {
    await runHook(opts, event, payload);
  };
}

// ── TurnStart ────────────────────────────────────────────────────

export interface TurnStartPayload {
  /** The kernel's rendering of `actions`. */
  readonly playerMessage: string;
  /** The player's resolved actions; empty for a turn without player input. */
  readonly actions: readonly TurnAction[];
  readonly activeRuntimes: readonly string[];
}

export async function runTurnStartHook(
  opts: BaseOpts,
  payload: TurnStartPayload,
): Promise<HookResult<TurnStartPayload>> {
  return (await runHook(opts, "TurnStart", payload)) ?? { action: "continue" };
}

// ── TurnStop ─────────────────────────────────────────────────────

interface TurnStopPayload {
  readonly runtimeResults: readonly RuntimeResult[];
  readonly durationMs: number;
}

export const runTurnStopHook = makeObserveHook<TurnStopPayload>("TurnStop");

// ── SessionStart / SessionEnd ────────────────────────────────────
// Session-lifecycle hooks fire outside any turn, so callers pass an empty
// `turnId` in BaseOpts. Both are observe-only (parallel): SessionStart cannot
// veto creation, SessionEnd is cleanup only.

export interface SessionStartPayload {
  readonly sessionId: string;
  readonly worldId?: string;
}

export const runSessionStartHook =
  makeObserveHook<SessionStartPayload>("SessionStart");

export interface SessionEndPayload {
  readonly sessionId: string;
  readonly reason: "ended" | "deleted";
}

export const runSessionEndHook =
  makeObserveHook<SessionEndPayload>("SessionEnd");

// ── PreCompaction / PostCompaction ───────────────────────────────

export interface PreCompactionPayload {
  /** Number of stored messages eligible for compaction this turn. */
  readonly messageCount: number;
}

/**
 * Veto gate before history compaction. Returns `skip: true` when any handler
 * aborts — the turn pipeline then leaves history uncompacted this turn
 * (mirrors pi's `session_before_compact` cancel path).
 */
export async function runPreCompactionHook(
  opts: BaseOpts,
  payload: PreCompactionPayload,
): Promise<{ readonly skip: boolean }> {
  const result = await runHook(opts, "PreCompaction", payload);
  return { skip: result?.action === "abort" };
}

interface PostCompactionPayload {
  readonly compacted: boolean;
  readonly summaryId?: string;
}

/** Observe the compaction outcome (parallel; return value is trace-only). */
export const runPostCompactionHook =
  makeObserveHook<PostCompactionPayload>("PostCompaction");

// ── PreSchedule ──────────────────────────────────────────────────

export interface PreSchedulePayload {
  /** Runtimes selected to run this turn, after trigger selection. */
  readonly triggered: readonly RuntimeManifest[];
}

/**
 * Observe / filter the set of runtimes scheduled this turn (after trigger
 * selection, before scheduling). Handlers may return `replace.triggered` to
 * narrow the set (e.g. conditional gating, cost control).
 *
 * Strictly filter-only: the returned list is reconciled against the
 * ORIGINAL `triggered` set by stable runtime identity (`manifest.name`) and
 * the framework re-uses the original manifest objects. A hook can therefore
 * drop or reorder runtimes but can never inject a manifest that was not
 * selected, nor swap a selected runtime's manifest for a mutated copy —
 * downstream trust decisions and the runtime loader key off manifest fields
 * (`pluginId`), which a fabricated manifest could forge to run
 * community handlers with builtin identity.
 *
 * `abort` has no defined meaning for PreSchedule and is treated as "no
 * change" — the original `triggered` set runs. To schedule no runtimes,
 * return `replace: { triggered: [] }`, not `abort`.
 */
export async function runPreScheduleHook(
  opts: BaseOpts,
  payload: PreSchedulePayload,
): Promise<readonly RuntimeManifest[]> {
  const result = await runHook(opts, "PreSchedule", payload);
  // `?? payload.triggered` covers both the no-pipeline path and the
  // `abort`/continue-without-replace paths. An explicit `replace: { triggered:
  // [] }` correctly returns the empty array (nullish, not falsy, coalescing).
  const replaced = hookReplace(result)?.triggered;
  if (!replaced) return payload.triggered;

  const originalByName = new Map(payload.triggered.map((m) => [m.name, m]));
  const filtered: RuntimeManifest[] = [];
  const seen = new Set<string>();
  for (const candidate of replaced) {
    const original = originalByName.get(candidate?.name);
    if (!original) {
      console.warn(
        `[hooks] PreSchedule replacement injected runtime "${candidate?.name}" not in the triggered set — dropped (filter-only contract)`,
      );
      continue;
    }
    if (seen.has(original.name)) continue;
    seen.add(original.name);
    filtered.push(original);
  }
  return filtered;
}

// ── PreRuntime ───────────────────────────────────────────────────

export async function runPreRuntimeHook(
  opts: BaseOpts & {
    readonly manifest: RuntimeManifest;
    readonly input: TurnInput;
  },
): Promise<HookResult<{ manifest: RuntimeManifest; input: TurnInput }>> {
  return (
    (await runHook(
      opts,
      "PreRuntime",
      { manifest: opts.manifest, input: opts.input },
      { pluginId: opts.manifest.pluginId, runtimeId: opts.manifest.name },
    )) ?? { action: "continue" }
  );
}

// ── PostRuntime ──────────────────────────────────────────────────

/**
 * PostRuntime runs once per logical runtime, when it ends: never on a
 * suspension, and with `resumed: true` at the end of a resumed one.
 */
export async function runPostRuntimeHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  result: RuntimeResult,
  { resumed = false }: { readonly resumed?: boolean } = {},
): Promise<RuntimeResult> {
  const hookResult = await runHook(
    opts,
    "PostRuntime",
    { result, ...(resumed ? { resumed: true } : {}) },
    { pluginId: opts.pluginId, runtimeId: opts.runtimeId },
  );
  const replacedResult = hookReplace(hookResult)?.result;
  if (!replacedResult) return result;
  // Hooks guard, rewrite or audit; they carry no writes. The write commands
  // (`pendingProposals`, `effects`) and `completion` always come from the
  // runtime itself — a hook that adds one would commit it under the rewritten
  // runtime's identity. A hook that wants to stop a write uses PreStateCommit.
  const {
    pendingProposals: _hookProposals,
    effects: _hookEffects,
    completion: _hookCompletion,
    // Write-service operations are the kernel's record of what the run's
    // code called; the kernel attaches them after this hook.
    operations: _hookOperations,
    operationWrites: _hookOperationWrites,
    ...replaced
  } = replacedResult;
  // A hook may rewrite output/status, never execution identity: the proposal
  // rebinder downstream keys writes on these fields, so an approved hook could
  // otherwise redirect another plugin's writes under a forged identity.
  // An output-only rewrite cannot silently publish the handler's old business
  // value. Hooks may explicitly replace canonicalValue; finalization validates it.
  const canonicalValue = result.canonicalValue
    ? !isDeepStrictEqual(replaced.output, result.output) &&
      isDeepStrictEqual(replaced.canonicalValue, result.canonicalValue)
      ? {}
      : (replaced.canonicalValue ?? {})
    : undefined;
  // The runtime's writes belong to the status it reported. When a hook changes
  // that status (failed → success, success → skipped, …) the result carries
  // no writes: a failed runtime's buffered writes never land through a
  // recovery, and a skip a hook forced commits nothing. Owned copies, like the
  // rest of the accepted result: a producer that still holds the originals
  // cannot change what commits.
  const status = replaced.status;
  const writes =
    status === result.status
      ? cloneHookData({
          ...(result.pendingProposals
            ? { pendingProposals: result.pendingProposals }
            : {}),
          ...(result.effects ? { effects: result.effects } : {}),
          ...(result.completion ? { completion: result.completion } : {}),
        })
      : {};
  // How the loop ended is the runtime's own record, like its identity. It
  // describes the status the runtime reported, so a changed status drops it:
  // a failure a hook turned into success keeps no stale `max-steps`.
  const { stop: _hookStop, ...rewritten } = replaced;
  const stop =
    status === result.status && result.stop ? { stop: result.stop } : {};
  return {
    ...rewritten,
    ...writes,
    ...stop,
    canonicalValue,
    pluginId: result.pluginId,
    runtimeId: result.runtimeId,
    runId: result.runId,
    turnId: result.turnId,
  };
}

// ── PostContextAssembly ──────────────────────────────────────────

/**
 * Assembled context exposed to PostContextAssembly hooks. Turn-level (once
 * per runtime, after buildContext, before the agent loop): handlers may
 * rewrite the assembled system prompt and/or projected history. Distinct from
 * the per-call PreLLMCall — this shapes the assembled context a single time
 * (mirrors pi's `before_agent_start`).
 */
export interface AssembledContextView {
  readonly systemPrompt: string;
  /**
   * The framework's own opening of `systemPrompt` (runtime frame,
   * output-language directive, completion contract). A handler that replaces
   * the system prompt does not have to carry it over: it is kept. Without it
   * the model is never told which language the session is in.
   */
  readonly frameworkHead?: string;
  readonly messages: readonly LLMMessage[];
  /**
   * Read-only `outputKind` of the runtime whose context was assembled
   * (`story` / `system`). Surfaced so PostContextAssembly handlers
   * can shape only the runtimes they care about (e.g. a narration director
   * that only touches story prompts) without hardcoding plugin ids — the
   * framework/plugin isolation rule. Optional and never rewritten by the hook;
   * purely informational. Absent when the caller does not supply it, keeping
   * the field a non-breaking addition.
   */
  readonly outputKind?: "story" | "system";
  /** Locale-resolved source template; informational and never hook-rewritten. */
  readonly promptTemplate?: string;
  /** Authoritative resolved inputs, before prompt serialization. */
  readonly inputSlots?: Readonly<Record<string, InputSlot>>;
  /** Existing character identities for bounded extraction/disambiguation. */
  readonly characters?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly type: string;
    readonly description?: string;
  }[];
  /**
   * The character the player acts as: the current character of the primary
   * seat, one of `characters`. Absent when no seat binds a character.
   */
  readonly currentCharacterId?: string;
  /** The `prompt.segment@1` segments this runtime's prompt was built with. */
  readonly promptSegments?: readonly IncludedPromptSegment[];
}

/**
 * One `prompt.segment@1` segment that is part of a runtime's prompt: the
 * plugin that provided it and the `id` that plugin gave it. A hook reads it to
 * learn what its own plugin put in the prompt without searching the text.
 */
export interface IncludedPromptSegment {
  readonly pluginId: string;
  readonly id: string;
}

/**
 * Keep the framework's opening on a system prompt that a hook rewrote. A
 * handler usually trims context by returning its own prompt body; the
 * language directive and completion contract are not its to drop.
 */
function withFrameworkHead(
  systemPrompt: string,
  frameworkHead: string | undefined,
): string {
  if (!frameworkHead || systemPrompt.startsWith(frameworkHead))
    return systemPrompt;
  return systemPrompt ? `${frameworkHead}\n\n${systemPrompt}` : frameworkHead;
}

export async function runPostContextAssemblyHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  assembled: AssembledContextView,
): Promise<AssembledContextView> {
  const payload: AssembledContextView = {
    systemPrompt: assembled.systemPrompt,
    messages: assembled.messages,
    outputKind: assembled.outputKind,
    promptTemplate: assembled.promptTemplate,
    inputSlots: assembled.inputSlots,
    characters: assembled.characters,
    currentCharacterId: assembled.currentCharacterId,
    promptSegments: assembled.promptSegments,
  };
  const hookResult = await runHook(opts, "PostContextAssembly", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      systemPrompt: withFrameworkHead(
        replace.systemPrompt ?? assembled.systemPrompt,
        assembled.frameworkHead,
      ),
      frameworkHead: assembled.frameworkHead,
      messages: replace.messages ?? assembled.messages,
      outputKind: assembled.outputKind,
      promptTemplate: assembled.promptTemplate,
      inputSlots: assembled.inputSlots,
      characters: assembled.characters,
      currentCharacterId: assembled.currentCharacterId,
      promptSegments: assembled.promptSegments,
    };
  }
  return assembled;
}

// ── PreStep ──────────────────────────────────────────────────────

/** Tool choice of one step; `"auto"` sends none. */
export type StepToolChoice = "auto" | "required" | { readonly name: string };

/** What a PreStep handler sees: the step the loop is about to run. */
export interface PreStepPayload {
  /** 1-based number of the step. */
  readonly step: number;
  /** Steps left including this one. */
  readonly stepsRemaining: number;
  /** The step limit in force. */
  readonly maxSteps: number;
  /** Names of the tools offered to the model this step. */
  readonly toolNames: readonly string[];
  /** The tool choice the loop would send. */
  readonly toolChoice: StepToolChoice;
}

/** What a PreStep handler may return in `replace`. */
export interface PreStepReplace {
  /** Offer only these tools this step; a subset of `toolNames`. */
  readonly tools?: readonly string[];
  readonly toolChoice?: StepToolChoice;
  /** Lower the steps left, this one included; never raises them. */
  readonly stepsRemaining?: number;
  /** End the loop before the model call. */
  readonly stop?: {
    readonly reason: "tool-finished" | "cancelled";
    readonly message?: string;
  };
}

/** The validated outcome; invalid parts of a replacement are dropped. */
export interface PreStepOutcome {
  /** The tools kept for this step, when a handler narrowed them. */
  readonly tools?: readonly string[];
  /** Names a handler gave that were not offered this step. */
  readonly ignoredTools: number;
  readonly toolChoice?: StepToolChoice;
  readonly stepsRemaining?: number;
  readonly stop?: {
    readonly reason: "tool-finished" | "cancelled";
    readonly message?: string;
  };
}

const MAX_PRE_STEP_STOP_MESSAGE = 500;

function isStepToolChoice(value: unknown): value is StepToolChoice {
  if (value === "auto" || value === "required") return true;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/**
 * Run PreStep before a step's model call. Sequential and transform-only, like
 * PreLLMCall: a failed handler is skipped and `abort` means "no change".
 */
export async function runPreStepHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  payload: PreStepPayload,
): Promise<PreStepOutcome> {
  const hookResult = await runHook<PreStepPayload & PreStepReplace>(
    opts,
    "PreStep",
    payload,
    { pluginId: opts.pluginId, runtimeId: opts.runtimeId },
  );
  const replace = hookReplace(hookResult) as
    Readonly<Record<string, unknown>> | undefined;
  if (!replace) return { ignoredTools: 0 };
  const offered = new Set(payload.toolNames);
  let tools: string[] | undefined;
  let ignoredTools = 0;
  if (Array.isArray(replace.tools)) {
    const kept = new Set<string>();
    for (const name of replace.tools) {
      if (typeof name === "string" && offered.has(name)) kept.add(name);
      else ignoredTools += 1;
    }
    tools = [...kept];
  }
  const stepTools = new Set(tools ?? payload.toolNames);
  const toolChoice =
    isStepToolChoice(replace.toolChoice) &&
    (typeof replace.toolChoice === "string" ||
      stepTools.has(replace.toolChoice.name))
      ? typeof replace.toolChoice === "string"
        ? replace.toolChoice
        : { name: replace.toolChoice.name }
      : undefined;
  const remaining = replace.stepsRemaining;
  const stepsRemaining =
    typeof remaining === "number" &&
    Number.isInteger(remaining) &&
    remaining >= 1 &&
    remaining < payload.stepsRemaining
      ? remaining
      : undefined;
  const rawStop = replace.stop;
  let stop: PreStepOutcome["stop"];
  if (typeof rawStop === "object" && rawStop !== null) {
    const { reason, message } = rawStop as Record<string, unknown>;
    if (reason === "tool-finished" || reason === "cancelled") {
      const text =
        typeof message === "string"
          ? message.trim().slice(0, MAX_PRE_STEP_STOP_MESSAGE)
          : "";
      stop = { reason, ...(text ? { message: text } : {}) };
    }
  }
  return {
    ...(tools ? { tools } : {}),
    ignoredTools,
    ...(toolChoice ? { toolChoice } : {}),
    ...(stepsRemaining !== undefined ? { stepsRemaining } : {}),
    ...(stop ? { stop } : {}),
  };
}

// ── PreLLMCall ───────────────────────────────────────────────────

/**
 * Request shape exposed to PreLLMCall hooks. Handlers may non-destructively
 * rewrite the messages / model / tools sent on a single LLM call without
 * mutating the runtime's canonical transcript (mirrors pi's `context` event).
 */
export interface PreLLMCallRequest {
  readonly messages: readonly LLMMessage[];
  readonly model: string | undefined;
  readonly tools: readonly LLMToolDefinition[] | undefined;
  /** A validating plugin may buffer output until its response check passes. */
  readonly stream?: false;
  /**
   * The `prompt.segment@1` segments the runtime's prompt was built with.
   * Absent on the calls of a resumed run, which is not assembled again.
   */
  readonly promptSegments?: readonly IncludedPromptSegment[];
}

export async function runPreLLMCallHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  request: PreLLMCallRequest,
): Promise<PreLLMCallRequest> {
  const hookResult = await runHook(opts, "PreLLMCall", request, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  // Transform-only: only `replace` is honoured (abort has no meaning here and
  // is treated as "no change", matching pi's non-destructive `context`).
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      messages: replace.messages ?? request.messages,
      model: replace.model ?? request.model,
      tools: replace.tools ?? request.tools,
      stream: replace.stream === false ? false : request.stream,
      promptSegments: request.promptSegments,
    };
  }
  return request;
}

// ── PostLLMResponse ──────────────────────────────────────────────

export interface PostLLMResponsePayload {
  readonly response: LLMResponse;
  /** Exact request sent to the provider, including governed tool results. */
  readonly messages: readonly LLMMessage[];
  /** Reject this draft and request a bounded correction before tool dispatch. */
  readonly correction?: string;
}

export async function runPostLLMResponseHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  response: LLMResponse,
  messages: readonly LLMMessage[],
): Promise<{ response: LLMResponse; correction?: string }> {
  const payload: PostLLMResponsePayload = { response, messages };
  const hookResult = await runHook(opts, "PostLLMResponse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  const replacement = hookReplace(hookResult);
  return {
    response: replacement?.response ?? response,
    correction: replacement?.correction?.trim() || undefined,
  };
}

// ── PreToolUse ───────────────────────────────────────────────────

interface PreToolUsePayload {
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}

export type PreToolUseOutcome =
  | {
      readonly skipped: false;
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: string;
      };
    }
  | { readonly skipped: true; readonly reason: string };

export async function runPreToolUseHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
): Promise<PreToolUseOutcome> {
  const payload: PreToolUsePayload = { toolCall };
  const hookResult = await runHook(opts, "PreToolUse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  if (hookResult?.action === "abort") {
    return { skipped: true, reason: hookResult.reason };
  }

  // Accumulate any toolCall replacement from the hook result.
  const replace = hookReplace(hookResult);
  const effectiveToolCall = replace?.toolCall
    ? {
        ...toolCall,
        ...(replace.toolCall as Partial<typeof toolCall>),
        // The assistant transcript already contains the provider-issued id.
        // Hooks may rewrite the dispatched name/arguments, but changing the id
        // would make the following tool-role message reference no call.
        id: toolCall.id,
      }
    : toolCall;
  return { skipped: false, toolCall: effectiveToolCall };
}

// ── PostToolUse ──────────────────────────────────────────────────

interface PostToolUsePayload {
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  readonly result: unknown;
  /**
   * Hooks may set this via `replace` to end the agent tool loop after this
   * result is recorded (mirrors pi's `tool_result.terminate`). The result is
   * still pushed back to the transcript; the loop simply stops afterwards.
   */
  readonly terminate?: boolean;
}

export interface PostToolUseOutcome<R> {
  readonly result: R;
  readonly terminate: boolean;
}

export async function runPostToolUseHook<R>(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
  result: R,
): Promise<PostToolUseOutcome<R>> {
  const payload: PostToolUsePayload = { toolCall, result };
  const hookResult = await runHook(opts, "PostToolUse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      result:
        replace.result !== undefined
          ? pinToolResultWrites(result, replace.result)
          : result,
      terminate: replace.terminate === true,
    };
  }
  return { result, terminate: false };
}

/**
 * Fields of a tool execution result that a PostToolUse hook cannot replace:
 * the writes and events the tool produced, whether it succeeded, and how it
 * was approved. A hook rewrites what the model reads (`result`,
 * `parsedResult`); a write it adds would commit under the runtime's identity.
 */
const PINNED_TOOL_RESULT_FIELDS = [
  "pendingProposals",
  "emittedEvents",
  "success",
  "error",
  "refused",
  "approvalStatus",
] as const;

function pinToolResultWrites<R>(original: R, replaced: unknown): R {
  if (
    typeof original !== "object" ||
    original === null ||
    typeof replaced !== "object" ||
    replaced === null
  )
    return original;
  const pinned: Record<string, unknown> = { ...replaced };
  const source = original as Record<string, unknown>;
  for (const field of PINNED_TOOL_RESULT_FIELDS) {
    if (Object.hasOwn(source, field)) pinned[field] = source[field];
    else delete pinned[field];
  }
  return pinned as R;
}
