import { afterEach, expect, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type {
  HandlerResult,
  JsonValue,
  Proposal,
  ProposalFor,
  RuntimeManifest,
  RuntimeResult,
  SubscriptionEvent,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import {
  createDefaultToolRegistry,
  tool,
  withPendingProposals,
  z,
  type ToolModule,
} from "@covel/tools";
import { executeTurn, commitExecution } from "../../src/index.js";
import type { ExecutionDeps } from "../../src/execution.js";
import { createToolExecutor } from "../../src/agent-loop/tool-executor.js";
import { createCommitPipeline } from "../../src/session/session-kernel.js";

export const SESSION = "world-reads";
export const AT = "2026-10-31T00:00:00.000Z";
export const input: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player",
};
export function fn(
  id: string,
  extra: Partial<RuntimeManifest> = {},
  pluginId = "observer",
): RuntimeManifest {
  return {
    name: `${pluginId}/${id}`,
    pluginId,
    description: id,
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    maxRetries: 0,
    ...extra,
  };
}
export const producer = fn("produce", { stage: "pre-turn" }, "source");
export const story = fn(
  "story",
  { stage: "narrative", outputKind: "story" },
  "storyteller",
);
export const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});
export const tell: FunctionHandler = async () =>
  ok({ narrativeOutput: "The story continues." });
export function proposal<T extends Proposal["type"]>(
  type: T,
  payload: ProposalFor<T>["payload"],
): ProposalFor<T> {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    source: { pluginId: "seed", runtimeId: "seed/run" },
    sessionId: SESSION,
    turnId: "seed-turn",
    timestamp: AT,
  };
}
export const character = (
  id = "source",
  description = "staged",
  expectedVersion?: number,
) =>
  proposal("character.upsert", {
    id,
    name: id,
    type: "npc",
    description,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
export const schema = () =>
  proposal("character.schema.set", {
    types: ["npc", "visitor"],
    attributes: [],
  });
export const writes = (...pending: Proposal[]) =>
  withPendingProposals(ok(), pending);
export const refuseProducer = (p: Proposal) =>
  p.source.runtimeId === producer.name ? "producer refused" : undefined;
export const stageCharacter = tool({
  name: "stage-character",
  description: "Stage a character description",
  parameters: z.object({ id: z.string(), description: z.string() }),
  execute: async ({ id, description }) =>
    withPendingProposals({ staged: true }, [character(id, description)]),
});
const stores: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
export async function fixture(
  options: {
    create?: () => DataStore;
    tools?: readonly ToolModule[];
    deps?: Partial<ExecutionDeps>;
  } = {},
) {
  const store = (options.create ?? createMemoryStore)();
  stores.push(store);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [],
    activePlugins: ["source", "observer", "storyteller", "service", "actor"],
    completedPlayerTurns: 0,
    createdAt: AT,
    updatedAt: AT,
  });
  const seeded = await createCommitPipeline(store).commitAll([
    proposal("character.schema.set", { types: ["npc"], attributes: [] }),
    character("source", "original"),
    character("derived", "original"),
  ]);
  expect(seeded.every((result) => result.committed)).toBe(true);
  const registry = createDefaultToolRegistry({
    store,
    eventDirectory: {
      listTopics: async () => [],
      validate: async () => ({ ok: true }),
    },
  });
  const modules = [stageCharacter, ...(options.tools ?? [])];
  const events: SubscriptionEvent[] = [];
  const eventBus = createEventBus(store);
  eventBus.onEmit((event) => {
    events.push(event);
  });
  const baseDeps: ExecutionDeps = {
    store,
    eventBus,
    loadRuntime: async () => undefined,
    llm: {
      generate: async () => {
        throw new Error("Unexpected model call");
      },
    },
    toolExecutor: createToolExecutor({
      store,
      findTool: (name, context) =>
        modules.find((m) => m.name === name) ??
        registry.find(name, context.pluginId),
      getToolSource: () => "builtin",
    }),
    ...options.deps,
  };
  async function execute(
    runtimes: readonly RuntimeManifest[],
    handlers: Record<string, FunctionHandler>,
    options: {
      input?: Partial<TurnInput>;
      guards?: Record<string, LoadedRuntime["guard"]>;
      deps?: Partial<ExecutionDeps>;
    } = {},
  ) {
    const deps: ExecutionDeps = {
      ...baseDeps,
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: manifest.name,
        handler: handlers[manifest.name],
        guard: options.guards?.[manifest.name],
      }),
      ...options.deps,
    };
    const execution = await executeTurn(
      { ...input, ...options.input },
      runtimes,
      deps,
    );
    const results = execution.commit.results as readonly RuntimeResult[];
    const resultOf = (runtime: RuntimeManifest) =>
      results.find((r) => r.runtimeId === runtime.name)!;
    const edges = (runtime: RuntimeManifest) =>
      execution.commit.readDependencies?.[resultOf(runtime).runId] ?? [];
    const commit = (
      proposalGuard?: (p: Proposal) => string | undefined,
      enqueueReleasedJobsInTx?: Parameters<
        typeof commitExecution
      >[0]["enqueueReleasedJobsInTx"],
    ) =>
      commitExecution({
        store,
        eventBus,
        execution,
        completion: {
          kind: "turn",
          turnId: options.input?.turnId ?? input.turnId,
          durationMs: 0,
        },
        ...(enqueueReleasedJobsInTx ? { enqueueReleasedJobsInTx } : {}),
        ...(proposalGuard ? { proposalGuard } : {}),
      });
    return { execution, deps, results, resultOf, edges, commit };
  }
  const notes = async (pluginId = "observer") =>
    Object.fromEntries(
      (await store.listPluginData(SESSION, pluginId, "notes")).map((r) => [
        r.key,
        r.value,
      ]),
    );
  return { store, eventBus, events, execute, notes, baseDeps };
}
