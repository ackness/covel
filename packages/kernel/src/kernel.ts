import { randomUUID } from "node:crypto";
import type { ModelParameterOverrides } from "@covel/ai-provider";
import type { CharacterCard, KernelInput, KernelTurnResult } from "@covel/shared";
import type { PluginHost } from "@covel/plugin-runtime";
import {
  createSessionPluginScope,
  createScopedRuntimeRegistry,
  createScopedToolRegistry,
  createScopedHookRegistry,
  createScopedContextProviders,
  type SessionPluginScope,
} from "@covel/plugin-runtime";
import type { GatewayLike } from "@covel/runtime";
import {
  createTurnContextStore,
  buildContextView,
  type RuntimeInfo,
  type ContextFragment,
} from "@covel/context";
import { routeTrigger } from "./router/trigger-router.js";
import { buildExecutionPlan } from "./scheduler/runtime-scheduler.js";
import { runRuntime } from "./runner/runtime-runner.js";
import { gatherContextFragments } from "./context/context-provider-bridge.js";
import { createPluginDataAccess } from "./data-access/plugin-data-access.js";
import { createProposalCollector } from "./proposals/proposal-collector.js";
import { validateProposals } from "./proposals/proposal-validator.js";
import { commitProposals } from "./commit/commit-service.js";
import { deepMerge } from "@covel/shared";
import { buildRenderResult } from "./render/render-builder.js";
import { executeHooks } from "./hooks/hook-executor.js";
import type { TurnState, KernelExecuteOptions, KernelProgressEvent, BackgroundTask, TurnCache, CachedRuntimeResult } from "./types.js";
import { DEFAULT_RUNTIME_PRIORITY, DEFAULT_BACKGROUND_THRESHOLD } from "./types.js";
import { createBackgroundTaskManager } from "./background/background-task-manager.js";
import {
  createPermissiveTrustPolicy,
  type TrustPolicy,
  type RuntimeTrustContext,
} from "./trust/trust-policy.js";

// ── Public types ───────────────────────────────────────────────────

export interface KernelSlotRegistry {
  resolveSlot(slotId: string): string | undefined;
  getSlotTag?(slotId: string): string | undefined;
  listSlotsByTag?(tag: string): Array<{ slotId: string; presetId: string }>;
  getParameterOverrides?(slotId: string): ModelParameterOverrides | undefined;
  listSlots?(): Record<string, { slotId: string; presetId: string }>;
}

export interface KernelBootstrapConfig {
  pluginHost: PluginHost;
  gateway: GatewayLike;
  /** Trust policy for runtime/tool/proposal gates. Default: allow-all. */
  trustPolicy?: TrustPolicy;
  /** Slot registry for resolving runtime model bindings. */
  slotRegistry?: KernelSlotRegistry;
}

/** @deprecated Use KernelBootstrapConfig */
export interface KernelDeps {
  pluginHost: PluginHost;
  gateway: GatewayLike;
  slotRegistry?: KernelSlotRegistry;
}

export interface KernelContext {
  /** Current game state. */
  state?: Record<string, unknown>;
  /** World data. */
  world?: unknown;
  /** Characters. */
  characters?: CharacterCard[];
  /** Chat history. */
  chat?: unknown;
  /** Runtime settings. */
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
  /** Archive data. */
  archive?: { activeVersion?: number; latestVersion?: number; summary?: string };
}

// ── Bootstrap → Instance → Session ─────────────────────────────────

/**
 * Bootstrap the kernel.
 *
 * This is the one-time initialization that sets up shared infra
 * (plugin registries, gateway, trust policy). Call `createSession()`
 * on the returned instance for per-session state.
 */
export interface CreateSessionOptions {
  /** Initial kernel context (game state, world, etc.). */
  initialContext?: Partial<KernelContext>;
  /** Plugin IDs to activate. Defaults to all enabled plugins. */
  activePlugins?: readonly string[];
  /**
   * Per-runtime priority overrides keyed by qualified runtime ID
   * ("pluginId:runtimeId"). Allows users to adjust runtime execution
   * order without modifying plugin manifests.
   */
  runtimePriorityOverrides?: Record<string, number>;
}

export function bootstrapKernel(config: KernelBootstrapConfig): KernelInstance {
  const { pluginHost, gateway, slotRegistry } = config;
  const trustPolicy = config.trustPolicy ?? createPermissiveTrustPolicy();

  function createSession(optionsOrContext?: CreateSessionOptions | Partial<KernelContext>): KernelSession {
    // Backward-compat: accept plain context object
    const opts: CreateSessionOptions =
      optionsOrContext && ("initialContext" in optionsOrContext || "activePlugins" in optionsOrContext)
        ? optionsOrContext as CreateSessionOptions
        : { initialContext: optionsOrContext as Partial<KernelContext> | undefined };

    return createKernelSession(
      { pluginHost, gateway, trustPolicy, slotRegistry },
      opts,
    );
  }

  return {
    createSession,
    pluginHost,
    gateway,
    trustPolicy,
  };
}

export interface KernelInstance {
  /** Create a new session with isolated context and optional plugin scope. */
  createSession(options?: CreateSessionOptions | Partial<KernelContext>): KernelSession;
  /** Shared plugin host (read-only access to registries). */
  readonly pluginHost: PluginHost;
  /** Shared AI gateway. */
  readonly gateway: GatewayLike;
  /** Active trust policy. */
  readonly trustPolicy: TrustPolicy;
}

export interface KernelSession {
  /** Execute a complete turn within this session. */
  executeTurn(input: KernelInput, options?: KernelExecuteOptions): Promise<KernelTurnResult>;
  /**
   * Retry the last turn from a specific runtime.
   *
   * All runtimes with priority < the target's priority group replay cached
   * results (injected into TurnContextStore without LLM calls). The target
   * runtime and all subsequent ones re-execute normally.
   *
   * Pass `fromRuntimeId = undefined` to retry the entire turn.
   */
  retryTurn(fromRuntimeId: string | undefined, options?: KernelExecuteOptions): Promise<KernelTurnResult>;
  /** Get the last turn's cached runtime results (for UI display). */
  getLastTurnCache(): TurnCache | null;
  /** Update session-level context (game state, world, etc.). */
  setContext(ctx: Partial<KernelContext>): void;
  /** Read current session context (snapshot). */
  getContext(): Readonly<KernelContext>;
  /** Enable a plugin for this session. Takes effect on next turn. */
  enablePlugin(pluginId: string): void;
  /** Disable a plugin for this session. Takes effect on next turn. */
  disablePlugin(pluginId: string): void;
  /** List active plugin IDs in this session. */
  listActivePlugins(): readonly string[];
  /** List all available (globally loaded) plugin IDs. */
  listAvailablePlugins(): readonly string[];
  /** The underlying plugin scope for this session. */
  readonly pluginScope: SessionPluginScope;
}

// ── Backward-compat wrapper ────────────────────────────────────────

/**
 * Create the execution kernel (backward-compatible API).
 *
 * Internally bootstraps a KernelInstance and creates a default session.
 * Prefer `bootstrapKernel()` + `instance.createSession()` for new code.
 */
export function createKernel(deps: KernelDeps): Kernel {
  const instance = bootstrapKernel(deps);
  const session = instance.createSession();
  return { executeTurn: session.executeTurn, setContext: session.setContext };
}

/** Backward-compat kernel type (default session). */
export type Kernel = {
  executeTurn: KernelSession["executeTurn"];
  setContext: KernelSession["setContext"];
};

// ── Locale resolution ─────────────────────────────────────────────

/** Resolve locale with 4-level fallback: input → run → world → app default */
function resolveLocale(
  inputLocale: string | undefined,
  ctx: KernelContext
): string {
  if (inputLocale) return inputLocale;

  // Try run.defaultLocale from runtimeSettings
  const runLocale = ctx.runtimeSettings?.flat?.defaultLocale;
  if (typeof runLocale === "string" && runLocale) return runLocale;

  // Try world.defaultLocale
  if (ctx.world && typeof ctx.world === "object" && "defaultLocale" in ctx.world) {
    const worldLocale = (ctx.world as Record<string, unknown>).defaultLocale;
    if (typeof worldLocale === "string" && worldLocale) return worldLocale;
  }

  return "zh-CN";
}

// ── Session implementation ─────────────────────────────────────────

/**
 * Resolve a runtime's slot name from the slot registry, with tag validation.
 * Returns undefined if: no binding, slot not found, or tag mismatch.
 */
function resolveTagValidatedSlotName(
  slotRegistry: KernelSlotRegistry,
  slotName: string,
  providerTag: string | undefined,
): string | undefined {
  const presetId = slotRegistry.resolveSlot(slotName);
  if (!presetId) return undefined;
  if (providerTag !== undefined && slotRegistry.getSlotTag) {
    const slotTag = slotRegistry.getSlotTag(slotName);
    if (slotTag !== undefined && slotTag !== providerTag) return undefined;
  }
  return slotName;
}

interface ResolvedDeps {
  pluginHost: PluginHost;
  gateway: GatewayLike;
  trustPolicy: TrustPolicy;
  slotRegistry?: KernelSlotRegistry;
}

function createKernelSession(
  deps: ResolvedDeps,
  opts?: CreateSessionOptions,
): KernelSession {
  let kernelContext: KernelContext = { ...opts?.initialContext };

  // Turn counter for interval-based runtime gating
  let turnCounter = 0;

  // Session-level runtime priority overrides (user-adjustable execution order)
  const sessionPriorityOverrides: Record<string, number> = { ...opts?.runtimePriorityOverrides };

  // Cache of the last turn's execution for retry support
  let lastTurnCache: TurnCache | null = null;

  // Session-scoped plugin activation
  const scope = createSessionPluginScope(
    deps.pluginHost.pluginRegistry,
    opts?.activePlugins,
  );
  const scopedRuntimes = createScopedRuntimeRegistry(deps.pluginHost.runtimeRegistry, scope);
  const scopedTools = createScopedToolRegistry(deps.pluginHost.toolRegistry, scope);
  const scopedHooks = createScopedHookRegistry(deps.pluginHost.hookRegistry, scope);
  const scopedContextProviders = createScopedContextProviders(deps.pluginHost.contextProviders, scope);

  function setContext(ctx: Partial<KernelContext>): void {
    kernelContext = { ...kernelContext, ...ctx };
  }

  function getContext(): Readonly<KernelContext> {
    return { ...kernelContext };
  }

  /**
   * Execute a complete turn.
   *
   * Pipeline:
   * 1. Trigger routing
   * 2. Priority-based scheduling (0 = first, 1000 = last)
   * 3. Context assembly via TurnContextStore + PromptAssembler
   * 4. Runtime execution (same priority = parallel)
   * 5. Proposal collection + validation
   * 6. State commit
   * 7. Render output
   */
  async function executeTurn(
    input: KernelInput,
    options: KernelExecuteOptions = {}
  ): Promise<KernelTurnResult> {
    const turnId = `turn-${randomUUID()}`;
    const traceId = options.traceId ?? `trace-${randomUUID()}`;
    const locale = resolveLocale(input.locale, kernelContext);

    // Increment session-level turn counter for interval gating
    turnCounter += 1;

    // Initialize TurnContextStore
    const contextStore = createTurnContextStore();
    contextStore.init({
      runId: input.runId,
      branchId: input.branchId,
      turnId,
      locale,
      world: kernelContext.world,
      characters: kernelContext.characters,
      chat: kernelContext.chat,
      state: { ...kernelContext.state },
      archive: kernelContext.archive,
      runtimeSettings: kernelContext.runtimeSettings,
    });

    // Initialize turn state (for proposals/commit)
    const turnState: TurnState = {
      state: { ...kernelContext.state },
      events: [],
      records: new Map(),
      narrativeSegments: [],
      renderBlocks: [],
    };

    // ── TurnStart hooks ──────────────────────────────────────────
    const turnStartResult = await executeHooks(scopedHooks, {
      event: "TurnStart",
      turnId,
      runId: input.runId,
      branchId: input.branchId,
      locale,
    });
    if (!turnStartResult.allowed) {
      return {
        runId: input.runId,
        branchId: input.branchId,
        turnId,
        traceId,
        locale,
        proposals: [],
        render: { blocks: [] },
        followUpEvents: [],
      };
    }

    // 1. Trigger routing (scoped to active plugins)
    const allRuntimes = scopedRuntimes.listAll();
    const { candidates } = routeTrigger(input, allRuntimes, turnCounter);

    // 2. Build execution plan (priority-based, scoped deps)
    const pluginDeps = new Map<string, string[]>();
    for (const pluginId of scope.listActive()) {
      const plugin = deps.pluginHost.pluginRegistry.get(pluginId);
      if (plugin) {
        pluginDeps.set(plugin.manifest.id, plugin.manifest.requires ?? []);
      }
    }
    // Merge session-level + per-turn priority overrides (per-turn wins)
    const effectivePriorityOverrides = {
      ...sessionPriorityOverrides,
      ...options.runtimePriorityOverrides,
    };
    const plan = buildExecutionPlan(candidates, pluginDeps, effectivePriorityOverrides);

    // 3-6. Execute groups sequentially, runtimes within a group in parallel
    const collector = createProposalCollector({
      runId: input.runId,
      branchId: input.branchId,
      turnId,
      traceId,
    });

    const emitProgress = (evt: Omit<KernelProgressEvent, "timestamp">) => {
      if (options.onProgress) {
        options.onProgress({ ...evt, timestamp: new Date().toISOString() });
      }
    };

    const backgroundThreshold = Math.max(0, Math.min(1000, options.backgroundThreshold ?? DEFAULT_BACKGROUND_THRESHOLD));
    const backgroundManager = createBackgroundTaskManager(options.onBackgroundTaskDone);
    const backgroundTasks: BackgroundTask[] = [];

    // ── Retry support: determine which groups to skip ──────────────
    const retryFromRuntimeId = options.retryFromRuntimeId;
    let retryFromPriority: number | null = null;

    if (retryFromRuntimeId && lastTurnCache) {
      // Find the priority of the target runtime in the cached results
      const cachedTarget = lastTurnCache.runtimeResults.find(
        (r) => r.runtimeId === retryFromRuntimeId
      );
      if (cachedTarget) {
        retryFromPriority = cachedTarget.priority;
      }
      // If target not found in cache, re-execute everything (retryFromPriority stays null)
    }

    // Collect runtime results for caching (populated during execution)
    const turnRuntimeResults: CachedRuntimeResult[] = [];

    for (const group of plan.groups) {
      // Check if this group should run in background (all members >= threshold)
      const isBackground = group.every(
        (s) => (s.priority) >= backgroundThreshold
      );

      if (isBackground) {
        // Enqueue as background tasks — don't await
        for (const scheduled of group) {
          if (scheduled.registered.spec.kind === "verifier") continue;

          const runtime = scheduled.registered;
          const spec = runtime.spec;

          // Trust gate: check if runtime is allowed
          const trustCtx: RuntimeTrustContext = {
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            kind: spec.kind,
          };
          const decision = deps.trustPolicy.canExecuteRuntime(trustCtx);
          if (!decision.allowed) {
            console.warn(`[kernel] Trust policy blocked background runtime ${spec.id}: ${decision.reason}`);
            continue;
          }

          // Snapshot mutable turn state at enqueue time so the background
          // closure does not read stale/reset data after foreground completes.
          const snapshotState = { ...turnState.state };
          const snapshotEvents = [...turnState.events];
          const snapshotRecords = new Map(turnState.records);
          const snapshotNarrativeSegments = [...turnState.narrativeSegments];
          const snapshotRenderBlocks = [...turnState.renderBlocks];

          const task = backgroundManager.enqueue(
            spec.id,
            runtime.pluginId,
            `Background runtime: ${spec.kind} (${spec.id})`,
            async () => {
              const runtimeInfo: RuntimeInfo = {
                runtimeId: spec.id,
                pluginId: runtime.pluginId,
                kind: spec.kind,
                priority: spec.priority ?? DEFAULT_RUNTIME_PRIORITY,
                allowedTools: spec.tools,
                providerTag: spec.providerTag,
                budget: spec.budget,
                isolation: spec.isolation,
              };

              const context = buildContextView(contextStore, runtimeInfo);
              const contextFragments = await gatherContextFragments(
                scopedContextProviders,
                {
                  pluginId: runtime.pluginId,
                  runtimeId: spec.id,
                  locale,
                  state: contextStore.getState(),
                  world: kernelContext.world,
                  characters: kernelContext.characters,
                }
              );
              const fragments: ContextFragment[] = contextFragments.map((f) => ({
                id: f.id,
                pluginId: f.pluginId,
                title: f.title,
                content: f.content,
                priority: f.priority,
              }));

              const snapshotTurnState: TurnState = {
                state: snapshotState,
                events: snapshotEvents,
                records: snapshotRecords,
                narrativeSegments: snapshotNarrativeSegments,
                renderBlocks: snapshotRenderBlocks,
              };

              const dataAccess = createPluginDataAccess({
                turnState: snapshotTurnState,
                characters: kernelContext.characters ?? [],
                events: snapshotEvents.map((e) => ({
                  eventType: e.type,
                  data: e.payload as Record<string, unknown> | undefined,
                })),
              });

              const qualifiedId = `${runtime.pluginId}:${spec.id}`;
              const boundSlot = options.runtimeBindings?.[qualifiedId];
              const resolvedSlotId =
                boundSlot && deps.slotRegistry
                  ? resolveTagValidatedSlotName(deps.slotRegistry, boundSlot, spec.providerTag)
                  : undefined;

              const result = await runRuntime(
                {
                  gateway: deps.gateway,
                  toolRegistry: scopedTools,
                  hookRegistry: scopedHooks,
                  slotRegistry: deps.slotRegistry,
                },
                runtime,
                context,
                {
                  apiKeys: options.apiKeys,
                  traceId,
                  contextFragments: fragments,
                  dataAccess,
                  resolvedSlotId,
                  slotPresetOverrides: options.slotPresetOverrides,
                  slotParameterOverrides: options.slotParameterOverrides,
                  onProgress: emitProgress,
                }
              );

              return {
                text: result.text,
                proposals: result.proposals,
              };
            }
          );

          backgroundTasks.push(task);
        }
        continue;
      }

      // ── Retry: replay cached results for groups before the retry point ──
      const groupPriority = group[0]?.priority ?? DEFAULT_RUNTIME_PRIORITY;
      if (retryFromPriority !== null && groupPriority < retryFromPriority && lastTurnCache) {
        // Inject cached results without re-executing
        for (const scheduled of group) {
          const runtimeId = scheduled.registered.spec.id;
          const cached = lastTurnCache.runtimeResults.find((r) => r.runtimeId === runtimeId);
          if (!cached) continue;

          emitProgress({
            type: "runtime.started",
            runtimeId,
            pluginId: scheduled.registered.pluginId,
            label: `${scheduled.registered.pluginId}/${scheduled.registered.spec.kind}`,
            detail: "[cached]",
          });

          // Inject into context store for downstream runtimes
          contextStore.ingest({
            runtimeId,
            pluginId: scheduled.registered.pluginId,
            narrative: cached.narrative || undefined,
            proposals: cached.proposals,
          });

          // Apply to turnState (same as normal execution, uses deepMerge for state.patch)
          collector.addFromRuntime(runtimeId, scheduled.registered.pluginId, cached.proposals);
          for (const item of cached.proposals) {
            switch (item.kind) {
              case "narrative.append": {
                const p = item.payload as { text: string };
                turnState.narrativeSegments.push(p.text);
                break;
              }
              case "state.patch": {
                turnState.state = deepMerge(
                  turnState.state,
                  item.payload as Record<string, unknown>,
                );
                break;
              }
              case "record.upsert": {
                const r = item.payload as { key: string; value: unknown };
                turnState.records.set(r.key, r.value);
                break;
              }
            }
          }

          // Cache the replayed result
          turnRuntimeResults.push({ ...cached });

          emitProgress({
            type: "runtime.completed",
            runtimeId,
            pluginId: scheduled.registered.pluginId,
            label: `${scheduled.registered.pluginId}/${scheduled.registered.spec.kind}`,
            detail: "[cached]",
          });
        }
        continue; // Skip to next group
      }

      // Foreground execution (existing logic)
      const results = await Promise.allSettled(
        group.map(async (scheduled) => {
          // Skip verifier runtimes (first-round)
          if (scheduled.registered.spec.kind === "verifier") return;

          const runtime = scheduled.registered;
          const spec = runtime.spec;

          // Trust gate: check if runtime is allowed
          const trustCtx: RuntimeTrustContext = {
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            kind: spec.kind,
          };
          const decision = deps.trustPolicy.canExecuteRuntime(trustCtx);
          if (!decision.allowed) {
            console.warn(`[kernel] Trust policy blocked runtime ${spec.id}: ${decision.reason}`);
            emitProgress({
              type: "runtime.failed",
              runtimeId: spec.id,
              pluginId: runtime.pluginId,
              label: `${runtime.pluginId}/${spec.kind}`,
              detail: `Blocked by trust policy: ${decision.reason ?? "denied"}`,
            });
            return;
          }

          emitProgress({
            type: "runtime.started",
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            label: `${runtime.pluginId}/${spec.kind}`,
            detail: spec.providerTag,
          });

          // Build RuntimeInfo for prompt assembler
          const runtimeInfo: RuntimeInfo = {
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            kind: spec.kind,
            priority: spec.priority ?? DEFAULT_RUNTIME_PRIORITY,
            allowedTools: spec.tools,
            providerTag: spec.providerTag,
            budget: spec.budget,
            isolation: spec.isolation,
          };

          // Gather context fragments from registered providers
          const contextFragments = await gatherContextFragments(
            scopedContextProviders,
            {
              pluginId: runtime.pluginId,
              runtimeId: spec.id,
              locale,
              state: contextStore.getState(),
              world: kernelContext.world,
              characters: kernelContext.characters,
            }
          );

          // Map to @covel/context ContextFragment type
          const fragments: ContextFragment[] = contextFragments.map((f) => ({
            id: f.id,
            pluginId: f.pluginId,
            title: f.title,
            content: f.content,
            priority: f.priority,
          }));

          // Build context view for the runtime (backward compat for custom handlers)
          const context = buildContextView(contextStore, runtimeInfo);

          // Create data access scoped to this runtime
          const dataAccess = createPluginDataAccess({
            turnState,
            characters: kernelContext.characters ?? [],
            events: turnState.events.map((e) => ({
              eventType: e.type,
              data: e.payload as Record<string, unknown> | undefined,
            })),
          });

          // Resolve per-runtime model binding (with tag compatibility check)
          const bgQualifiedId = `${runtime.pluginId}:${spec.id}`;
          const bgBoundSlot = options.runtimeBindings?.[bgQualifiedId];
          const resolvedSlotId =
            bgBoundSlot && deps.slotRegistry
              ? resolveTagValidatedSlotName(deps.slotRegistry, bgBoundSlot, spec.providerTag)
              : undefined;

          // Run the runtime
          const result = await runRuntime(
            {
              gateway: deps.gateway,
              toolRegistry: scopedTools,
              hookRegistry: scopedHooks,
              slotRegistry: deps.slotRegistry,
            },
            runtime,
            context,
            {
              apiKeys: options.apiKeys,
              traceId,
              contextFragments: fragments,
              dataAccess,
              resolvedSlotId,
              slotPresetOverrides: options.slotPresetOverrides,
              slotParameterOverrides: options.slotParameterOverrides,
              onProgress: emitProgress,
            }
          );

          emitProgress({
            type: "runtime.completed",
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            label: `${runtime.pluginId}/${spec.kind}`,
          });

          // Collect proposals
          collector.addFromRuntime(spec.id, runtime.pluginId, result.proposals);

          // Ingest output into TurnContextStore for downstream runtimes
          contextStore.ingest({
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            narrative: result.text || undefined,
            proposals: result.proposals,
          });

          // Cache runtime result for retry support
          turnRuntimeResults.push({
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            priority: spec.priority ?? DEFAULT_RUNTIME_PRIORITY,
            narrative: result.text || "",
            proposals: result.proposals,
          });

          // NOTE: State application is deferred to after Promise.allSettled
          // to prevent race conditions between parallel runtimes (H19).
          return result.proposals;
        })
      );

      // Log failures but continue
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
          const failedScheduled = group[i];
          console.warn("[kernel] Runtime execution failed:", result.reason);
          if (failedScheduled) {
            emitProgress({
              type: "runtime.failed",
              runtimeId: failedScheduled.registered.spec.id,
              pluginId: failedScheduled.registered.pluginId,
              label: `${failedScheduled.registered.pluginId}/${failedScheduled.registered.spec.kind}`,
              detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        }
      }

      // ── Serial post-group state apply (H19 fix) ──────────────────
      // Apply proposals to turnState *after* the parallel group completes,
      // so parallel runtimes cannot race on shared mutable state.
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value) continue;
        const proposals = result.value;
        for (const item of proposals) {
          switch (item.kind) {
            case "narrative.append": {
              const p = item.payload as { text: string };
              turnState.narrativeSegments.push(p.text);
              break;
            }
            case "state.patch": {
              turnState.state = deepMerge(
                turnState.state,
                item.payload as Record<string, unknown>,
              );
              break;
            }
            case "record.upsert": {
              const r = item.payload as { key: string; value: unknown };
              turnState.records.set(r.key, r.value);
              break;
            }
          }
        }
      }
    }

    // 7. Validate proposals
    const allProposals = collector.getAll();
    const { valid, rejected } = validateProposals(allProposals);

    if (rejected.length > 0) {
      console.warn(
        `[kernel] ${rejected.length} proposal(s) rejected:`,
        rejected.map((r) => r.reason)
      );
    }

    // ── PreStateCommit hooks ────────────────────────────────────
    const preCommitResult = await executeHooks(scopedHooks, {
      event: "PreStateCommit",
      turnId,
      runId: input.runId,
      branchId: input.branchId,
      locale,
      proposals: valid,
    });

    // 8. Commit — reset eagerly-applied state and rebuild from validated proposals
    const preCommitState = structuredClone(kernelContext.state) as Record<string, unknown>;
    turnState.narrativeSegments = [];
    turnState.state = { ...kernelContext.state };
    turnState.records = new Map();
    turnState.events = [];
    turnState.renderBlocks = [];

    let commitResult;
    if (preCommitResult.allowed) {
      commitResult = commitProposals(turnState, valid, {
        turnId,
        branchId: input.branchId,
      });

      // Update kernel state with committed changes (immutable update)
      kernelContext = { ...kernelContext, state: { ...turnState.state } };

      // ── PostStateCommit hooks ───────────────────────────────────
      await executeHooks(scopedHooks, {
        event: "PostStateCommit",
        turnId,
        runId: input.runId,
        branchId: input.branchId,
        locale,
        proposals: valid,
      });
    } else {
      console.warn(`[kernel] PreStateCommit hook blocked commit: ${preCommitResult.reason}`);
    }

    // 9. Render
    const render = buildRenderResult(turnState);

    // ── TurnStop hooks ────────────────────────────────────────────
    await executeHooks(scopedHooks, {
      event: "TurnStop",
      turnId,
      runId: input.runId,
      branchId: input.branchId,
      locale,
    });

    // Cache turn results for retry support
    lastTurnCache = {
      turnId,
      input,
      runtimeResults: turnRuntimeResults,
      apiKeys: options.apiKeys,
      runtimeBindings: options.runtimeBindings,
      slotPresetOverrides: options.slotPresetOverrides,
      slotParameterOverrides: options.slotParameterOverrides,
      preCommitState,
    };

    // Build state snapshot for persistence (only when commit succeeded)
    const stateSnapshot = commitResult
      ? {
          state: { ...turnState.state },
          events: [...turnState.events],
          records: Object.fromEntries(turnState.records),
        }
      : undefined;

    return {
      runId: input.runId,
      branchId: input.branchId,
      turnId,
      traceId,
      locale,
      proposals: allProposals,
      commit: commitResult,
      render,
      followUpEvents: [],
      backgroundTasks: backgroundTasks.length > 0 ? backgroundTasks : undefined,
      stateSnapshot,
    };
  }

  /**
   * Retry the last turn from a specific runtime.
   *
   * Runtimes before the target's priority group replay cached results
   * (no LLM calls). The target and all subsequent runtimes re-execute.
   *
   * If fromRuntimeId is undefined, retries the entire turn.
   */
  async function retryTurn(
    fromRuntimeId: string | undefined,
    options: KernelExecuteOptions = {}
  ): Promise<KernelTurnResult> {
    if (!lastTurnCache) {
      throw new Error("[kernel] No previous turn to retry. Execute at least one turn first.");
    }

    // Revert kernel state to before the last turn's commit
    // (The last turn's commit updated kernelContext.state — we need to undo it
    //  so that the retry re-applies from the same baseline.)
    // Note: For simplicity, we re-execute with the same input. The context
    // is set externally by the server before each turn, so it should be correct.

    // Revert kernel state to pre-commit snapshot so retry starts from the same baseline
    kernelContext = { ...kernelContext, state: { ...lastTurnCache.preCommitState } };

    const retryInput = lastTurnCache.input;
    const retryOptions: KernelExecuteOptions = {
      ...options,
      apiKeys: options.apiKeys ?? lastTurnCache.apiKeys,
      runtimeBindings: options.runtimeBindings ?? lastTurnCache.runtimeBindings,
      slotPresetOverrides: options.slotPresetOverrides ?? lastTurnCache.slotPresetOverrides,
      slotParameterOverrides: options.slotParameterOverrides ?? lastTurnCache.slotParameterOverrides,
      retryFromRuntimeId: fromRuntimeId,
    };

    return executeTurn(retryInput, retryOptions);
  }

  function getLastTurnCache(): TurnCache | null {
    return lastTurnCache;
  }

  return {
    executeTurn,
    retryTurn,
    getLastTurnCache,
    setContext,
    getContext,
    enablePlugin: (pluginId: string) => scope.enable(pluginId),
    disablePlugin: (pluginId: string) => scope.disable(pluginId),
    listActivePlugins: () => scope.listActive(),
    listAvailablePlugins: () => scope.listAvailable(),
    pluginScope: scope,
  };
}
