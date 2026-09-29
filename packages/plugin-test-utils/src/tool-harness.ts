import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  isJsonValue,
  type JsonValue,
  type RuntimeManifest,
} from "@covel/shared";
import {
  commitExecution,
  createToolExecutor,
  executeTurn,
  type ToolCallContext,
} from "@covel/runtime";
import {
  getEmittedEvents,
  getPendingProposals,
  withEmittedEvents,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import type { ToolModule, z } from "@covel/tools";

/** A real, isolated session store for tool integration tests. */
export async function createPluginTestStore(context: {
  readonly sessionId: string;
  readonly pluginId: string;
}): Promise<DataStore> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: context.sessionId,
    locale: "en",
    activePlugins: [context.pluginId],
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

/**
 * Commit already-produced tool results as one execution, including pending
 * overlays from multiple calls. Uses the same validation/transaction boundary
 * as the host; it never writes proposal payloads directly to the store.
 */
export async function commitToolResults(
  results: readonly unknown[],
  context: ToolCallContext,
  store: DataStore,
): Promise<void> {
  await executeAndCommitResults(async () => results, context, store);
}

/** Run a tool through the real executor and commit its effects atomically. */
export async function executeToolAndCommit<TOutput>(
  module: ToolModule<z.ZodType, TOutput>,
  params: Record<string, unknown>,
  context: ToolCallContext,
  store: DataStore,
): Promise<TOutput> {
  let raw!: TOutput;
  let toolError: unknown;
  const executor = createToolExecutor({
    store,
    findTool: () => ({
      ...module,
      async execute(args, ctx) {
        try {
          return (raw = await module.execute(args, ctx));
        } catch (error) {
          toolError = error;
          throw error;
        }
      },
    }),
  });
  try {
    await executeAndCommitResults(
      async () => {
        const result = await executor.execute(
          {
            toolCallId: crypto.randomUUID(),
            name: module.name,
            arguments: JSON.stringify(params),
          },
          context,
        );
        if (!result.success) throw toolError ?? new Error(result.result);
        return [
          withEmittedEvents(
            withPendingProposals(
              result.parsedResult,
              result.pendingProposals ?? [],
            ),
            [...(result.emittedEvents ?? [])],
          ),
        ];
      },
      context,
      store,
    );
    return raw;
  } finally {
    await executor.close();
  }
}

async function executeAndCommitResults(
  run: () => Promise<readonly unknown[]>,
  context: ToolCallContext,
  store: DataStore,
): Promise<void> {
  const manifest: RuntimeManifest = {
    name: context.runtimeId,
    description: "Tool integration test",
    pluginId: context.pluginId,
    runtimeType: "function",
    stage: "narrative",
    outputKind: "plugin",
    trigger: { type: "manual" },
  };
  let executionError: unknown;
  const execution = await executeTurn(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      playerMessage: "",
      origin: "manual",
      manualTrigger: { runtimeId: manifest.name },
    },
    [manifest],
    {
      store,
      llm: {
        generate: async () => {
          throw new Error("Tool harness does not call an LLM");
        },
      },
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "",
        handler: async () => {
          try {
            const results = await run();
            const events: JsonValue[] = results
              .flatMap((result) => getEmittedEvents(result) ?? [])
              .map((event) => {
                if (!isJsonValue(event))
                  throw new Error("Tool event must be JSON");
                return event;
              });
            return withPendingProposals(
              { outcome: "success" as const, effects: { events } },
              results.flatMap(getPendingProposals),
            );
          } catch (error) {
            executionError = error;
            throw error;
          }
        },
      }),
    },
  );
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "detached", turnId: context.turnId },
  });
  if (executionError) throw executionError;
  if (outcome.status !== "committed") {
    throw new Error(
      outcome.error ??
        outcome.failedProposals[0]?.error ??
        "Tool execution commit failed",
    );
  }
}
