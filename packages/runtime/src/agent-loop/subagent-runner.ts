import {
  CHARACTER_ACTOR_CONTRACT,
  characterActorInputSchema,
  characterActorOutputJsonSchema,
  characterActorOutputSchema,
  type WorldModelView,
} from "@covel/shared";
import {
  createDelegationBudget,
  type DelegationBudget,
} from "../orchestration/delegation-budget.js";
import { buildCharacterBrief } from "../orchestration/character-brief.js";
/**
 * Sub-agents: an agent runtime that another runtime runs inside its own
 * execution, through `ctx.agents.run` (function runtimes) or the `delegate`
 * tool (agent runtimes).
 *
 * A sub-agent has its own transcript (the caller's brief, no session history)
 * and its own budget, and returns output only: no proposals, no events and no
 * top-level `RuntimeResult`, so it never forms a commit unit. It runs the
 * shared agent loop and settle step unchanged; the kernel narrows its tool
 * list to read-only tools, caps how deep and how many sub-agents run, and
 * passes the caller's cancellation down.
 *
 * One runner exists per top-level execution; nested
 * executions share it, so the pool cap counts every sub-agent the execution
 * has in flight.
 */

import type {
  ExecutionContext,
  LLMMessage,
  LoopStop,
  RuntimeManifest,
  StopReason,
  SubagentErrorCode,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import { modelFacingJson } from "@covel/shared";
import { buildContext } from "@covel/context";
import { AiProviderError } from "@covel/ai-provider";
import {
  DELEGATE_TOOL_NAME,
  SUBAGENT_BRIEF_MAX_CHARS,
  validateOutput,
} from "@covel/tools";
import { z } from "zod";
import { createWorldModelView } from "../function-runtime/world-model-view.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import { DEFAULT_RUNTIME_TIMEOUT_MS } from "../turn-executor/runtime-scaffold.js";
import { unwrapRetryCause } from "../turn-executor/runtime-finalization.js";
import { combineAbortSignals } from "../turn-executor/turn-control.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { DEFAULT_MAX_TOOL_STEPS } from "./agent-loop-policy.js";
import { settleAgentLoop } from "./settle-agent-loop.js";
import { stopOf } from "./stop-reason.js";
import type { OperationStage } from "../operations/operation-stage.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "./agent-tool-surface.js";
import { withSubagentDelegate } from "./subagent-delegate.js";
import type { ToolExecutor } from "./tool-executor.js";
import { runAgentToolLoop } from "./turn-agent-tool-loop.js";

/** A scheduled runtime runs sub-agents at depth 1; a sub-agent runs none. */
export const SUBAGENT_MAX_DEPTH = 1;
/** Sub-agents one execution may have in flight; another call is refused. */
export const SUBAGENT_POOL_PER_EXECUTION = 8;
/** Largest `data` object, serialized as JSON. */
export const SUBAGENT_DATA_MAX_BYTES = 32 * 1024;

/** The runtime that asks for a sub-agent. */
export interface SubagentCaller {
  readonly pluginId: string;
  readonly runtimeId: string;
  /** The caller's own sub-agent depth: 0 for a scheduled runtime. */
  readonly depth: number;
}

export interface SubagentRunArgs {
  readonly caller: SubagentCaller;
  readonly world?: WorldModelView;
  /** The request as the plugin or the model wrote it; validated here. */
  readonly request: unknown;
  /** The caller's turn input. */
  readonly input: TurnInput;
  /** The caller's dependencies; `toolExecutor` must be the unwrapped one. */
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline?: HookPipeline;
  readonly executionContext: ExecutionContext;
  /** The `delegate` tool call ID, or the calling function runtime's run ID. */
  readonly parentCallId: string;
  /** Aborts the sub-agent with the caller (deadline, revoke, loop end). */
  readonly parentSignal?: AbortSignal;
  /** Epoch ms when the caller's own time runs out, when it is fixed. */
  readonly parentDeadline?: number;
  /**
   * The caller's operation stage. The sub-agent's write-service calls stage
   * in a child of it, handed to the caller only when the sub-agent
   * succeeds. Without it the sub-agent cannot call write services.
   */
  readonly operations?: OperationStage;
}

/** How one sub-agent run ended, for the fault latch. */
export interface SubagentSettledEvent {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly callerPluginId: string;
  readonly callerRuntimeId: string;
  readonly ok: boolean;
  readonly fault?: "runtime" | "timeout";
  readonly stopReason?: StopReason;
  readonly code?: SubagentErrorCode;
}

export interface SubagentRunner {
  privateTargetKind(
    request: unknown,
    caller: SubagentCaller,
  ): "actor" | "concealed" | undefined;
  /** Never throws for a sub-agent failure: it resolves with `ok: false`. */
  run(args: SubagentRunArgs): Promise<SubagentResult>;
  /** Sub-agents of this execution now in flight. */
  readonly inFlight: number;
}

export interface CreateSubagentRunnerOptions {
  readonly delegation?: DelegationBudget;
  /** The execution's active runtimes, after provider resolution. */
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** Paused providers still participate in target resolution and ambiguity. */
  readonly pausedRuntimes?: readonly RuntimeManifest[];
  /**
   * Called once per run that reached a provider. The host collects these
   * outcomes for fault attribution at the execution's commit boundary.
   */
  readonly onSettled?: (event: SubagentSettledEvent) => void;
}

const requestSchema = z.strictObject({
  target: z.union([
    z.strictObject({ contract: z.string().min(1) }),
    z.strictObject({ runtimeId: z.string().min(1) }),
  ]),
  brief: z.string().min(1).max(SUBAGENT_BRIEF_MAX_CHARS),
  data: z.record(z.string(), z.unknown()).optional(),
  characterId: z.string().min(1).optional(),
  instruction: z.string().max(2_000).optional(),
  budget: z
    .strictObject({
      maxSteps: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});
type ParsedRequest = z.infer<typeof requestSchema>;

const MESSAGES = {
  timeout: "The sub-agent ran out of time before it answered",
  cancelled: "The sub-agent was cancelled with its caller",
  internal: "The sub-agent failed without producing output",
  depth:
    "The delegation depth limit is reached; finish without further children",
  pool: "The concurrent delegation limit is reached; finish without further children",
} as const;

export function createSubagentRunner(
  options: CreateSubagentRunnerOptions,
): SubagentRunner {
  let inFlight = 0;
  let budget = options.delegation;
  let loadingBudget: Promise<DelegationBudget> | undefined;
  const runner: SubagentRunner = {
    privateTargetKind(request, caller) {
      const parsed = parseRequest(request);
      if (typeof parsed === "string") return undefined;
      const target = resolveTarget(
        options.activeRuntimes,
        options.pausedRuntimes ?? [],
        parsed.target,
        caller,
      );
      const provider = target.provider;
      return provider?.concealed
        ? "concealed"
        : provider?.outputContract === CHARACTER_ACTOR_CONTRACT
          ? "actor"
          : undefined;
    },
    get inFlight() {
      return inFlight;
    },
    async run(args) {
      const subagentCallId = crypto.randomUUID();
      const startTime = Date.now();
      const trace = {
        subagentCallId,
        parentCallId: args.parentCallId,
        parentRuntimeId: args.caller.runtimeId,
        parentPluginId: args.caller.pluginId,
        turnId: args.input.turnId,
      };
      const refuse = async (
        code: SubagentErrorCode,
        message: string,
        provider?: RuntimeManifest,
      ): Promise<SubagentResult> => {
        await emitSafely(args.deps.emitter, "subagent.failed", {
          ...trace,
          ...(provider
            ? { runtimeId: provider.name, pluginId: provider.pluginId }
            : {}),
          error: message,
          code,
          durationMs: Date.now() - startTime,
        });
        return { ok: false, error: { code, message } };
      };

      const parsed = parseRequest(args.request);
      if (typeof parsed === "string") return refuse("invalid-input", parsed);
      const target = resolveTarget(
        options.activeRuntimes,
        options.pausedRuntimes ?? [],
        parsed.target,
        args.caller,
      );
      if ("code" in target)
        return refuse(target.code, target.message, target.provider);

      const actor = target.provider.outputContract === CHARACTER_ACTOR_CONTRACT;
      if (actor) {
        if (
          parsed.data !== undefined ||
          !characterActorInputSchema.safeParse({
            characterId: parsed.characterId,
            brief: parsed.brief,
            ...(parsed.instruction !== undefined
              ? { instruction: parsed.instruction }
              : {}),
          }).success
        )
          return refuse(
            "invalid-input",
            "Character actors require characterId and brief; use instruction instead of data",
          );
      } else if (
        parsed.characterId !== undefined ||
        parsed.instruction !== undefined
      ) {
        return refuse(
          "invalid-input",
          "Character fields are only accepted by character actors",
        );
      }
      const world =
        args.world ??
        (actor && args.deps.store
          ? await createWorldModelView(
              args.deps.worldModelReads ?? args.deps.store,
              args.input.sessionId,
              [],
              [],
              () => {},
              args.deps.dimensionContext,
            )
          : undefined);
      const character = actor
        ? world?.characters.find(
            (character) => character.id === parsed.characterId,
          )
        : undefined;
      if (actor && !character)
        return refuse(
          "not-found",
          "The character is not in the current world view",
        );
      budget ??= await (loadingBudget ??= createDelegationBudget(
        args.input.sessionId,
        args.deps.store,
      ));
      const delegation = budget;
      // No await between the last cancellation/pool check and admission.
      if (
        args.parentSignal?.aborted ||
        args.deps.turnControl?.executionSignal?.aborted ||
        args.deps.turnControl?.signal?.aborted
      )
        return refuse("cancelled", MESSAGES.cancelled);
      if (args.caller.depth + 1 > SUBAGENT_MAX_DEPTH)
        return refuse("unavailable", MESSAGES.depth);
      if (inFlight >= SUBAGENT_POOL_PER_EXECUTION)
        return refuse("unavailable", MESSAGES.pool);
      if (budget.claim(actor ? parsed.characterId : undefined))
        return refuse(
          "unavailable",
          "The execution's delegation allowance is exhausted; finish without further children",
        );
      inFlight++;
      try {
        const { fault, ...result } = await withServiceOrigin(args, () =>
          runProvider({
            args: {
              ...args,
              world,
              deps: {
                ...args.deps,
                delegation,
                emitter: delegation.privacy.emitter(
                  args.deps.emitter,
                  options.activeRuntimes,
                ),
              },
            },
            request: parsed,
            provider: target.provider,
            subagentCallId,
            startTime,
            trace,
            runner,
          }),
        );
        options.onSettled?.({
          pluginId: target.provider.pluginId,
          runtimeId: target.provider.name,
          callerPluginId: args.caller.pluginId,
          callerRuntimeId: args.caller.runtimeId,
          ok: result.ok,
          ...(fault ? { fault } : {}),
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
          ...(result.ok ? {} : { code: result.error.code }),
        });
        return result;
      } finally {
        inFlight--;
      }
    },
  };
  return runner;
}

/**
 * Run a sub-agent with the execution's service observer tagging each call
 * with the scheduled runtime the sub-agent works for, so the fault latch
 * classifies the call in that runtime's scope (a setup runtime's calls
 * neither count nor clear).
 */
function withServiceOrigin<T>(
  args: SubagentRunArgs,
  run: () => Promise<T>,
): Promise<T> {
  const services = args.deps.services;
  const observer = services?.executionObserver();
  if (!services || !observer) return run();
  return services.withExecutionObserver(
    (outcome) =>
      observer(
        outcome.originRuntimeId !== undefined
          ? outcome
          : { ...outcome, originRuntimeId: args.caller.runtimeId },
      ),
    run,
  );
}

/** The validated request, or the reason it is invalid. */
function parseRequest(raw: unknown): ParsedRequest | string {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return `The sub-agent request is invalid${at}: ${issue?.message ?? "unknown problem"}`;
  }
  if (parsed.data.data !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(parsed.data.data);
    } catch {
      return "The sub-agent request is invalid at data: it is not JSON";
    }
    if (new TextEncoder().encode(json).length > SUBAGENT_DATA_MAX_BYTES)
      return `The sub-agent request is invalid at data: it is larger than ${SUBAGENT_DATA_MAX_BYTES} bytes as JSON`;
  }
  return parsed.data;
}

/**
 * `{ runtimeId }` names a sub-agent runtime of the caller's own package;
 * `{ contract }` names the one active sub-agent provider of a contract.
 * `activeRuntimes` is already provider-resolved, so a default provider has
 * yielded to an explicit one.
 */
function resolveTarget(
  activeRuntimes: readonly RuntimeManifest[],
  pausedRuntimes: readonly RuntimeManifest[],
  target: ParsedRequest["target"],
  caller: SubagentCaller,
):
  | { readonly provider: RuntimeManifest }
  | {
      readonly code: SubagentErrorCode;
      readonly message: string;
      readonly provider?: RuntimeManifest;
    } {
  const providers = [
    ...activeRuntimes.map((provider) => ({ provider, paused: false })),
    ...pausedRuntimes.map((provider) => ({ provider, paused: true })),
  ].filter(
    ({ provider }) =>
      provider.subagentOnly && provider.runtimeType !== "function",
  );
  const resolved = ({ provider, paused }: (typeof providers)[number]) =>
    paused
      ? {
          code: "unavailable" as const,
          message:
            "runtimeId" in target
              ? `The sub-agent runtime "${target.runtimeId}" is paused in this session after repeated errors`
              : `The sub-agent provider for contract "${target.contract}" is paused in this session after repeated errors`,
          provider,
        }
      : { provider };
  if ("runtimeId" in target) {
    const provider = providers.find(
      ({ provider }) =>
        provider.name === target.runtimeId &&
        provider.pluginId === caller.pluginId,
    );
    return provider
      ? resolved(provider)
      : {
          code: "not-found",
          message: `No active sub-agent runtime "${target.runtimeId}" in plugin "${caller.pluginId}"`,
        };
  }
  const matches = providers.filter(
    ({ provider }) => provider.outputContract === target.contract,
  );
  const [provider] = matches;
  if (!provider)
    return {
      code: "not-found",
      message: `No active sub-agent provider for contract "${target.contract}"`,
    };
  if (matches.length > 1)
    return {
      code: "ambiguous",
      message: `More than one active sub-agent provider for contract "${target.contract}"`,
    };
  return resolved(provider);
}

/**
 * The provider's tool names a sub-agent at `depth` keeps: read-only tools
 * only, never `suspend`, and `delegate` only while another level is allowed.
 * A name that does not resolve is kept, so the missing-tool check still fails
 * the run with its own diagnostic.
 *
 * Imported services (`tools.services`) stay as declared, write services
 * included: the sub-agent resolves them as itself when it starts, and a
 * write service's operations join the caller's commit unit. Dataset tools
 * keep only their reads (`get`, `list`); a dataset left with none is
 * dropped.
 */
export function subagentToolNames(
  manifest: RuntimeManifest,
  toolExecutor: ToolExecutor | undefined,
  options: {
    readonly depth: number;
    readonly sessionId: string;
    readonly turnId: string;
  },
): RuntimeManifest["tools"] {
  const tools = manifest.tools;
  if (!tools) return undefined;
  const context = {
    sessionId: options.sessionId,
    turnId: options.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };
  const keep = (name: string): boolean => {
    if (name === "suspend") return false;
    if (name === DELEGATE_TOOL_NAME && options.depth >= SUBAGENT_MAX_DEPTH)
      return false;
    const info = toolExecutor?.getToolInfo(name, context);
    return info === undefined || info.annotations.readOnly === true;
  };
  return {
    ...tools,
    ...(tools.builtin ? { builtin: tools.builtin.filter(keep) } : {}),
    ...(tools.plugin ? { plugin: tools.plugin.filter(keep) } : {}),
    ...(Array.isArray(tools.defer) ? { defer: tools.defer.filter(keep) } : {}),
    ...(tools.datasets
      ? {
          datasets: tools.datasets.flatMap(({ dataset, tools: kinds }) => {
            const reads = kinds.filter(
              (kind) => kind === "get" || kind === "list",
            );
            return reads.length > 0 ? [{ dataset, tools: reads }] : [];
          }),
        }
      : {}),
  };
}

interface ProviderRun {
  readonly args: SubagentRunArgs;
  readonly request: ParsedRequest;
  readonly provider: RuntimeManifest;
  readonly subagentCallId: string;
  readonly startTime: number;
  readonly trace: Readonly<Record<string, unknown>>;
  readonly runner: SubagentRunner;
}

async function runProvider({
  args,
  request,
  provider,
  subagentCallId,
  startTime,
  trace,
  runner,
}: ProviderRun): Promise<
  SubagentResult & { readonly fault?: "runtime" | "timeout" }
> {
  const { deps } = args;
  const depth = args.caller.depth + 1;
  const identity = {
    ...trace,
    runtimeId: provider.name,
    pluginId: provider.pluginId,
  };
  const usage = { inputTokens: 0, outputTokens: 0, reported: false };
  const emitter = subagentEmitter(deps.emitter, trace, usage);
  // Operations of this run count only when it succeeds, and are its own.
  const operations = args.operations?.child({
    pluginId: provider.pluginId,
    runtimeId: provider.name,
  });
  const fail = async (
    code: SubagentErrorCode,
    message: string,
    stop?: LoopStop,
    cause?: unknown,
  ): Promise<SubagentResult & { readonly fault?: "runtime" | "timeout" }> => {
    operations?.discard();
    let fault: "runtime" | "timeout" | undefined;
    if (
      !args.parentSignal?.aborted &&
      !deps.turnControl?.executionSignal?.aborted &&
      !deps.turnControl?.signal?.aborted
    ) {
      if (stop?.reason === "deadline") {
        if (timeoutSource === "provider") fault = "timeout";
      } else if (
        stop?.reason === "max-steps" ||
        stop?.reason === "invalid-output" ||
        stop?.reason === "loop-detected" ||
        stop?.reason === "context-overflow"
      ) {
        fault = "runtime";
      } else if (
        !stop &&
        cause !== undefined &&
        !(unwrapRetryCause(cause) instanceof AiProviderError)
      ) {
        // Loading, context and world-view throws count just like top-level
        // runtime failures. Provider errors and cancellations remain neutral.
        fault = "runtime";
      }
    }
    if (code === "internal")
      // The real reason stays in the server log; the caller and the trace
      // get fixed text (`io.concealed` rule).
      console.warn("[subagent] run failed", {
        runtimeId: provider.name,
        parentRuntimeId: args.caller.runtimeId,
        error: cause instanceof Error ? cause.message : cause,
      });
    await emitSafely(deps.emitter, "subagent.failed", {
      ...identity,
      code,
      error: message,
      ...(stop ? { stopReason: stop.reason } : {}),
      ...(stop?.cancelledBy ? { cancelledBy: stop.cancelledBy } : {}),
      ...(fault ? { fault } : {}),
      durationMs: Date.now() - startTime,
    });
    return {
      ok: false,
      error: { code, message },
      ...(stop ? { stopReason: stop.reason } : {}),
      ...(fault ? { fault } : {}),
    };
  };

  await emitSafely(deps.emitter, "subagent.started", identity);

  // The caller's input with the brief as the only user message. Its model
  // overrides are the session's (`runtimeModelOverrides`, keyed by this
  // provider's runtimeId); the request-scoped story override, the caller's
  // manual or detached activation and the player's actions do not carry over.
  const {
    modelOverride: _modelOverride,
    manualTrigger: _manualTrigger,
    detachedStage: _detachedStage,
    actions: _actions,
    ...inherited
  } = args.input;
  const input: TurnInput = {
    ...inherited,
    playerMessage:
      request.data === undefined
        ? request.brief
        : `${request.brief}\n\n${JSON.stringify(modelFacingJson(request.data))}`,
  };

  const providerTimeout = provider.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const requestTimeout = request.budget?.timeoutMs ?? Infinity;
  const parentTimeout =
    args.parentDeadline !== undefined
      ? args.parentDeadline - Date.now()
      : Infinity;
  const timeoutMs = Math.min(providerTimeout, requestTimeout, parentTimeout);
  // The provider wins ties; a caller's tighter limit is not its fault.
  const timeoutSource =
    providerTimeout === timeoutMs
      ? "provider"
      : requestTimeout === timeoutMs
        ? "request"
        : "parent";
  if (timeoutMs <= 0) return fail("timeout", MESSAGES.timeout);
  const maxSteps = Math.min(
    request.budget?.maxSteps ?? Infinity,
    provider.maxSteps ?? DEFAULT_MAX_TOOL_STEPS,
  );
  const innerExecutor = deps.toolExecutor;
  const manifest: RuntimeManifest = {
    ...provider,
    tools: subagentToolNames(provider, innerExecutor, {
      depth,
      sessionId: input.sessionId,
      turnId: input.turnId,
    }),
    // A sub-agent acts a part: no streaming, no steering, unless the
    // provider names a profile itself.
    loopProfile: {
      ...provider.loopProfile,
      preset: provider.loopProfile?.preset ?? "actor",
    },
    maxSteps,
  };

  const executionSignal = combineAbortSignals(
    deps.turnControl?.executionSignal,
    args.parentSignal,
  );
  // The sub-agent resolves its own imports, as itself; the surface wraps the
  // raw executor, then `delegate` wraps that.
  const surfaceExecutor = innerExecutor
    ? withAgentToolSurface(
        innerExecutor,
        await prepareAgentToolSurface({
          manifest,
          input,
          deps,
          canWrite: operations !== undefined,
        }),
        deps.services,
        operations,
      )
    : undefined;
  const subDeps: TurnExecutorDeps = {
    ...deps,
    onDelta: undefined,
    emitter,
    // The player's abort and the caller's cancellation reach the sub-agent;
    // the steering queue does not.
    turnControl: {
      ...(deps.turnControl?.signal ? { signal: deps.turnControl.signal } : {}),
      ...(executionSignal ? { executionSignal } : {}),
    },
    toolExecutor:
      surfaceExecutor && depth < SUBAGENT_MAX_DEPTH
        ? withSubagentDelegate(surfaceExecutor, runner, {
            caller: {
              pluginId: provider.pluginId,
              runtimeId: provider.name,
              depth,
            },
            input,
            deps: { ...deps, toolExecutor: innerExecutor },
            executionContext: args.executionContext,
            ...(operations ? { operations } : {}),
          })
        : surfaceExecutor,
  };

  try {
    const providerLoaded = await deps.loadRuntime(
      provider,
      input.locale,
      input.sessionId,
    );
    if (!providerLoaded) return fail("internal", MESSAGES.internal);
    const actor = provider.outputContract === CHARACTER_ACTOR_CONTRACT;
    const canonical = actor ? characterActorOutputJsonSchema() : undefined;
    const loaded = canonical
      ? {
          ...providerLoaded,
          outputSchema: providerLoaded.outputSchema
            ? { allOf: [canonical, providerLoaded.outputSchema] }
            : canonical,
          outputContractSchema: canonical,
        }
      : providerLoaded;
    if (actor) {
      const character = args.world?.characters.find(
        (candidate) => candidate.id === request.characterId,
      );
      if (!character || !deps.delegation)
        return fail("internal", MESSAGES.internal);
      const history = await deps.delegation.history.read(
        character.id,
        args.world,
      );
      (input as { playerMessage: string }).playerMessage =
        await buildCharacterBrief(
          character,
          history,
          request.brief,
          request.instruction,
          input.locale,
        );
    }

    // The provider's own prompt with no session history: the context
    // builder's framework frame and completion contract, then the brief.
    // A write the provider asked for in the previous turn that did not
    // take effect is told to it, as to a scheduled agent.
    const notices = deps.failedOperationSummaries?.[provider.name];
    const assembled = await buildContext({
      promptTemplate: loaded.promptTemplate,
      manifest,
      turnInput: input,
      completedResults: new Map(),
      messageHistory: [],
      ...(notices?.length ? { failedOperationSummaries: notices } : {}),
      ...(deps.store ? { store: deps.store } : {}),
      ...withUserSettings(manifest, input),
    });
    const messages: LLMMessage[] = [
      { role: "system", content: assembled.systemPrompt },
      ...assembled.messages,
    ];
    // The caller's world only resolves the actor's profile and brief; the
    // sub-agent's own reads stay on committed data, like every child run.
    const worldBase = deps.store
      ? await createWorldModelView(
          deps.worldModelReads ?? deps.store,
          input.sessionId,
          [],
          [],
          () => {},
          deps.dimensionContext,
        )
      : undefined;

    const toolLoop = await runAgentToolLoop({
      worldBase,
      manifest,
      input,
      loaded,
      deps: subDeps,
      maxSteps,
      timeoutMs,
      messages,
      ...(deps.estimator && deps.contextBudget
        ? { estimator: deps.estimator, contextBudget: deps.contextBudget }
        : {}),
      currentTurnUserMessages: assembled.currentTurnUserMessages,
      hookPipeline: args.hookPipeline ?? deps.hookPipeline,
      startTime,
      runId: subagentCallId,
      executionContext: args.executionContext,
      allowSuspend: false,
    });
    // Without suspension the loop always completes; a terminal result here
    // would be a kernel fault.
    if ("status" in toolLoop)
      return fail("internal", MESSAGES.internal, undefined, toolLoop.error);

    const settled = settleAgentLoop({
      manifest,
      input,
      runId: subagentCallId,
      startTime,
      toolLoop,
      outputSchema: loaded.outputSchema,
    });
    const writes =
      toolLoop.pendingProposals.length +
      toolLoop.emittedEvents.length +
      (settled.result.pendingProposals?.length ?? 0) +
      (settled.result.effects?.events?.length ?? 0);
    if (writes > 0)
      // Defence in depth: the tool filter and read-only enforcement should
      // make this impossible. A sub-agent never writes; drop them.
      await emitSafely(deps.emitter, "subagent.writes-dropped", {
        ...identity,
        count: writes,
      });
    if (settled.kind === "failed") {
      const stop = settled.result.stop;
      return fail(
        codeForStop(stop),
        messageFor(codeForStop(stop)),
        stop,
        settled.result.error,
      );
    }
    const output = (settled.result.output ?? {}) as Record<string, unknown>;
    if (actor && !characterActorOutputSchema.safeParse(output).success)
      return fail("internal", MESSAGES.internal, { reason: "invalid-output" });
    if (provider.outputContract && loaded.outputContractSchema) {
      let valid = false;
      try {
        valid = validateOutput(output, loaded.outputContractSchema).valid;
      } catch {
        valid = false;
      }
      if (!valid)
        return fail(
          "internal",
          MESSAGES.internal,
          { reason: "invalid-output" },
          `contract-output-invalid (${provider.outputContract})`,
        );
    }
    const stopReason = settled.result.stop?.reason ?? "completed";
    operations?.commit();
    await emitSafely(deps.emitter, "subagent.completed", {
      ...identity,
      stopReason,
      durationMs: Date.now() - startTime,
      ...(usage.reported
        ? {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
          }
        : {}),
    });
    return {
      ok: true,
      output: structuredClone(output),
      stopReason,
      ...(usage.reported
        ? {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
          }
        : {}),
    };
  } catch (error) {
    let stop = stopOf(error, subagentCallId);
    // The model-call layer reports any execution abort as the player's. Only
    // the player's own signal is; any other abort came from the caller.
    if (
      stop?.reason === "cancelled" &&
      stop.cancelledBy === "player" &&
      !deps.turnControl?.signal?.aborted
    )
      stop = { ...stop, cancelledBy: "parent" };
    const code = codeForStop(stop);
    return fail(code, messageFor(code), stop, error);
  }
}

function withUserSettings(
  manifest: RuntimeManifest,
  input: TurnInput,
): { readonly userSettings?: Readonly<Record<string, unknown>> } {
  const userSettings = resolveUserSettings(manifest, input.userSettings);
  return userSettings ? { userSettings } : {};
}

function codeForStop(stop: LoopStop | undefined): SubagentErrorCode {
  if (stop?.reason === "deadline") return "timeout";
  if (
    stop?.reason === "cancelled" &&
    (stop.cancelledBy === "parent" ||
      stop.cancelledBy === "player" ||
      stop.cancelledBy === "host")
  )
    return "cancelled";
  return "internal";
}

function messageFor(code: SubagentErrorCode): string {
  return code === "timeout"
    ? MESSAGES.timeout
    : code === "cancelled"
      ? MESSAGES.cancelled
      : MESSAGES.internal;
}

/**
 * The caller's emitter, adding the call-tree fields to every event of the
 * sub-agent run, and summing the usage its steps report.
 */
function subagentEmitter(
  parent: TurnEmitter | undefined,
  fields: Readonly<Record<string, unknown>>,
  usage: { inputTokens: number; outputTokens: number; reported: boolean },
): TurnEmitter {
  const { subagentCallId, parentCallId, parentRuntimeId } = fields;
  const tree = { subagentCallId, parentCallId, parentRuntimeId };
  return {
    sessionId: parent?.sessionId ?? "",
    turnId: parent?.turnId ?? "",
    ...(parent?.traceId !== undefined ? { traceId: parent.traceId } : {}),
    async emit(type, payload) {
      if (type === "step.completed") {
        const step = payload.usage as
          { inputTokens?: unknown; outputTokens?: unknown } | undefined;
        if (
          typeof step?.inputTokens === "number" &&
          typeof step.outputTokens === "number"
        ) {
          usage.inputTokens += step.inputTokens;
          usage.outputTokens += step.outputTokens;
          usage.reported = true;
        }
      }
      await parent?.emit(type, { ...payload, ...tree });
    },
  };
}

async function emitSafely(
  emitter: TurnEmitter | undefined,
  type:
    | "subagent.started"
    | "subagent.completed"
    | "subagent.failed"
    | "subagent.writes-dropped",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitter?.emit(type, payload);
  } catch {
    console.warn("[subagent] trace delivery failed", { type });
  }
}
