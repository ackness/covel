import type { CharacterCard, KernelInput, KernelTurnResult } from "@covel/shared";
import type { PluginHost } from "@covel/plugin-runtime";
import type { GatewayLike } from "@covel/runtime";
import {
  createTurnContextStore,
  buildContextView,
  assemblePrompt,
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
import { buildRenderResult } from "./render/render-builder.js";
import type { TurnState, KernelExecuteOptions, KernelProgressEvent, BackgroundTask } from "./types.js";
import { createBackgroundTaskManager } from "./background/background-task-manager.js";
import {
  createPermissiveTrustPolicy,
  type TrustPolicy,
  type RuntimeTrustContext,
} from "./trust/trust-policy.js";

// ── Public types ───────────────────────────────────────────────────

export interface KernelBootstrapConfig {
  pluginHost: PluginHost;
  gateway: GatewayLike;
  /** Trust policy for runtime/tool/proposal gates. Default: allow-all. */
  trustPolicy?: TrustPolicy;
}

/** @deprecated Use KernelBootstrapConfig */
export interface KernelDeps {
  pluginHost: PluginHost;
  gateway: GatewayLike;
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
export function bootstrapKernel(config: KernelBootstrapConfig): KernelInstance {
  const { pluginHost, gateway } = config;
  const trustPolicy = config.trustPolicy ?? createPermissiveTrustPolicy();

  function createSession(initialContext?: Partial<KernelContext>): KernelSession {
    return createKernelSession(
      { pluginHost, gateway, trustPolicy },
      initialContext,
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
  /** Create a new session with isolated context. */
  createSession(initialContext?: Partial<KernelContext>): KernelSession;
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
  /** Update session-level context (game state, world, etc.). */
  setContext(ctx: Partial<KernelContext>): void;
  /** Read current session context (snapshot). */
  getContext(): Readonly<KernelContext>;
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

// ── Session implementation ─────────────────────────────────────────

interface ResolvedDeps {
  pluginHost: PluginHost;
  gateway: GatewayLike;
  trustPolicy: TrustPolicy;
}

function createKernelSession(
  deps: ResolvedDeps,
  initialContext?: Partial<KernelContext>,
): KernelSession {
  let kernelContext: KernelContext = { ...initialContext };

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
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = options.traceId ?? `trace-${Date.now()}`;
    const locale = input.locale ?? "zh-CN";

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

    // 1. Trigger routing
    const allRuntimes = deps.pluginHost.runtimeRegistry.listAll();
    const { candidates } = routeTrigger(input, allRuntimes);

    // 2. Build execution plan (priority-based)
    const pluginDeps = new Map<string, string[]>();
    for (const plugin of deps.pluginHost.pluginRegistry.listEnabled()) {
      pluginDeps.set(plugin.manifest.id, plugin.manifest.requires ?? []);
    }
    const plan = buildExecutionPlan(candidates, pluginDeps);

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

    const backgroundThreshold = options.backgroundThreshold ?? 800;
    const backgroundManager = createBackgroundTaskManager(options.onBackgroundTaskDone);
    const backgroundTasks: BackgroundTask[] = [];

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

          const task = backgroundManager.enqueue(
            spec.id,
            runtime.pluginId,
            `Background runtime: ${spec.kind} (${spec.id})`,
            async () => {
              const runtimeInfo: RuntimeInfo = {
                runtimeId: spec.id,
                pluginId: runtime.pluginId,
                kind: spec.kind,
                priority: spec.priority ?? 500,
                allowedTools: spec.tools,
                providerBinding: spec.providerBinding,
                budget: spec.budget,
                isolation: spec.isolation,
              };

              const context = buildContextView(contextStore, runtimeInfo);
              const contextFragments = await gatherContextFragments(
                deps.pluginHost.contextProviders,
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

              const dataAccess = createPluginDataAccess({
                turnState,
                characters: kernelContext.characters ?? [],
                events: turnState.events.map((e) => ({
                  eventType: (e as Record<string, unknown>).eventType as string,
                  data: (e as Record<string, unknown>).data as Record<string, unknown> | undefined,
                })),
              });

              const binding = spec.providerBinding;
              const resolvedPresetId = binding && options.slotOverrides?.[binding]
                ? options.slotOverrides[binding].presetId
                : undefined;

              const result = await runRuntime(
                {
                  gateway: deps.gateway,
                  toolRegistry: deps.pluginHost.toolRegistry,
                  hookRegistry: deps.pluginHost.hookRegistry,
                },
                runtime,
                context,
                {
                  apiKeys: options.apiKeys,
                  traceId,
                  contextFragments: fragments,
                  dataAccess,
                  resolvedPresetId,
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
              label: spec.kind,
              detail: `Blocked by trust policy: ${decision.reason ?? "denied"}`,
            });
            return;
          }

          emitProgress({
            type: "runtime.started",
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            label: spec.kind,
            detail: spec.providerBinding,
          });

          // Build RuntimeInfo for prompt assembler
          const runtimeInfo: RuntimeInfo = {
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            kind: spec.kind,
            priority: spec.priority ?? 500,
            allowedTools: spec.tools,
            providerBinding: spec.providerBinding,
            budget: spec.budget,
            isolation: spec.isolation,
          };

          // Gather context fragments from registered providers
          const contextFragments = await gatherContextFragments(
            deps.pluginHost.contextProviders,
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
              eventType: (e as Record<string, unknown>).eventType as string,
              data: (e as Record<string, unknown>).data as Record<string, unknown> | undefined,
            })),
          });

          // Resolve per-request slot override for this runtime's providerBinding
          const binding = spec.providerBinding;
          const resolvedPresetId = binding && options.slotOverrides?.[binding]
            ? options.slotOverrides[binding].presetId
            : undefined;

          // Emit llm.calling for LLM-backed runtimes (no handler = LLM path)
          if (!runtime.handler) {
            emitProgress({
              type: "llm.calling",
              runtimeId: spec.id,
              pluginId: runtime.pluginId,
              label: spec.kind,
              detail: resolvedPresetId ?? spec.providerBinding,
            });
          }

          // Run the runtime
          const result = await runRuntime(
            {
              gateway: deps.gateway,
              toolRegistry: deps.pluginHost.toolRegistry,
              hookRegistry: deps.pluginHost.hookRegistry,
            },
            runtime,
            context,
            {
              apiKeys: options.apiKeys,
              traceId,
              contextFragments: fragments,
              dataAccess,
              resolvedPresetId,
            }
          );

          emitProgress({
            type: "runtime.completed",
            runtimeId: spec.id,
            pluginId: runtime.pluginId,
            label: spec.kind,
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

          // Also apply to turnState for proposal tracking
          for (const item of result.proposals) {
            switch (item.kind) {
              case "narrative.append": {
                const p = item.payload as { text: string };
                turnState.narrativeSegments.push(p.text);
                break;
              }
              case "state.patch": {
                Object.assign(turnState.state, item.payload as Record<string, unknown>);
                break;
              }
              case "record.upsert": {
                const r = item.payload as { key: string; value: unknown };
                turnState.records.set(r.key, r.value);
                break;
              }
            }
          }
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
              label: failedScheduled.registered.spec.kind,
              detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
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

    // 8. Commit — reset eagerly-applied state and rebuild from validated proposals
    turnState.narrativeSegments = [];
    turnState.state = { ...kernelContext.state };
    turnState.records = new Map();
    turnState.events = [];
    turnState.renderBlocks = [];

    const commitResult = commitProposals(turnState, valid, {
      turnId,
      branchId: input.branchId,
    });

    // Update kernel state with committed changes
    kernelContext.state = { ...turnState.state };

    // 9. Render
    const render = buildRenderResult(turnState);

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
    };
  }

  return { executeTurn, setContext, getContext };
}
