import type { CharacterCard, KernelInput, KernelTurnResult } from "@covel/shared";
import type { PluginHost } from "@covel/plugin-runtime";
import type { GatewayLike } from "@covel/runtime";
import { routeTrigger } from "./router/trigger-router.js";
import { buildExecutionPlan } from "./scheduler/runtime-scheduler.js";
import { assembleContext } from "./context/context-assembler.js";
import { runRuntime } from "./runner/runtime-runner.js";
import { gatherContextFragments } from "./context/context-provider-bridge.js";
import { createPluginDataAccess } from "./data-access/plugin-data-access.js";
import { createProposalCollector } from "./proposals/proposal-collector.js";
import { validateProposals } from "./proposals/proposal-validator.js";
import { commitProposals } from "./commit/commit-service.js";
import { buildRenderResult } from "./render/render-builder.js";
import type { TurnState, KernelExecuteOptions } from "./types.js";

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

/**
 * Create the execution kernel.
 *
 * The kernel orchestrates the full turn execution pipeline:
 * 1. Trigger routing
 * 2. Runtime scheduling
 * 3. Context assembly
 * 4. Runtime execution
 * 5. Proposal collection + validation
 * 6. State commit
 * 7. Render output
 */
export function createKernel(deps: KernelDeps) {
  let kernelContext: KernelContext = {};

  /** Update the kernel's shared context (game state, world, etc.). */
  function setContext(ctx: Partial<KernelContext>): void {
    kernelContext = { ...kernelContext, ...ctx };
  }

  /**
   * Execute a complete turn.
   */
  async function executeTurn(
    input: KernelInput,
    options: KernelExecuteOptions = {}
  ): Promise<KernelTurnResult> {
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = options.traceId ?? `trace-${Date.now()}`;
    const locale = input.locale ?? "zh-CN";

    // Initialize turn state
    const turnState: TurnState = {
      state: { ...kernelContext.state },
      events: [],
      records: new Map(),
      narrativeSegments: [],
      renderBlocks: [],
    };

    // 1. Trigger routing
    const allRuntimes = deps.pluginHost.runtimeRegistry.listAll();
    const { triggerEvent, candidates } = routeTrigger(input, allRuntimes);

    // 2. Build execution plan
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

    for (const group of plan.groups) {
      // Track proposals from this group specifically
      const groupProposals: Array<{ runtimeId: string; pluginId: string; proposals: Array<{ kind: string; payload: unknown }> }> = [];

      const results = await Promise.allSettled(
        group.map(async (scheduled) => {
          // Skip verifier runtimes (first-round)
          if (scheduled.registered.spec.kind === "verifier") return;

          // 3. Assemble context
          const context = assembleContext({
            runId: input.runId,
            branchId: input.branchId,
            turnId,
            locale,
            runtime: scheduled.registered,
            triggerEvent: scheduled.triggerEvent,
            turnState,
            worldState: kernelContext.world,
            characters: kernelContext.characters,
            chat: kernelContext.chat,
            runtimeSettings: kernelContext.runtimeSettings,
            archive: kernelContext.archive,
          });

          // 4. Gather context fragments from registered providers
          const contextFragments = await gatherContextFragments(
            deps.pluginHost.contextProviders,
            {
              pluginId: scheduled.registered.pluginId,
              runtimeId: scheduled.registered.spec.id,
              locale,
              state: turnState.state,
              world: kernelContext.world,
              characters: kernelContext.characters,
            }
          );

          // 5. Create data access scoped to this runtime
          const dataAccess = createPluginDataAccess({
            turnState,
            characters: kernelContext.characters ?? [],
            events: turnState.events.map((e) => ({
              eventType: (e as Record<string, unknown>).eventType as string,
              data: (e as Record<string, unknown>).data as Record<string, unknown> | undefined,
            })),
          });

          // 6. Run the runtime
          const result = await runRuntime(
            {
              gateway: deps.gateway,
              toolRegistry: deps.pluginHost.toolRegistry,
              hookRegistry: deps.pluginHost.hookRegistry,
            },
            scheduled.registered,
            context,
            {
              apiKeys: options.apiKeys,
              traceId,
              contextFragments,
              dataAccess,
            }
          );

          // 7. Collect proposals
          collector.addFromRuntime(
            scheduled.registered.spec.id,
            scheduled.registered.pluginId,
            result.proposals
          );

          groupProposals.push({
            runtimeId: scheduled.registered.spec.id,
            pluginId: scheduled.registered.pluginId,
            proposals: result.proposals,
          });
        })
      );

      // Log failures but continue (failure policy: continue is default)
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("[kernel] Runtime execution failed:", result.reason);
        }
      }

      // Eagerly apply this group's proposals to turnState so the next group
      // can see accumulated output (narrative, state, records).
      for (const gp of groupProposals) {
        for (const item of gp.proposals) {
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
    };
  }

  return { executeTurn, setContext };
}

export type Kernel = ReturnType<typeof createKernel>;
