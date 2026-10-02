import { afterEach } from "vitest";
import type { TurnExecutorDeps } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import type { SessionLock } from "../../../src/lib/session-lock.js";
import { createRuntimeJobExecutor } from "../../../src/routes/api/plugin-rpc/runtime-job-executor.js";
import {
  createRuntimeJobWorker,
  type RuntimeJobWorker,
} from "../../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { createPluginRpcRuntimeTurnRunner } from "../../../src/routes/api/plugin-rpc/runtime-turn.js";

const workers = new Set<RuntimeJobWorker>();

afterEach(async () => {
  const closing = [...workers].map((worker) => worker.close());
  workers.clear();
  await Promise.all(closing);
});

/**
 * A real runtime job worker and executor for route tests that assemble their
 * own app: queued background jobs run with the test's runtime loader and LLM.
 */
export function createTestRuntimeJobWorker(args: {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly sessionLock: SessionLock;
  readonly pluginRegistry: PluginRegistry;
  readonly deps: Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter">;
}): RuntimeJobWorker {
  const execute = createRuntimeJobExecutor({
    store: args.store,
    eventBus: args.eventBus,
    registry: args.pluginRegistry,
    createRunner: (job, services, activeRuntimes, session, approvalScope) =>
      createPluginRpcRuntimeTurnRunner({
        store: args.store,
        eventBus: args.eventBus,
        sessionLock: args.sessionLock,
        sessionId: job.sessionId,
        session,
        activeRuntimes,
        pluginRegistry: args.pluginRegistry,
        approvalScopes: new Map([[job.pluginId, approvalScope]]),
        deps: { ...args.deps, llm: services.llm },
        ...(args.deps.hookPipeline
          ? { hookPipeline: args.deps.hookPipeline }
          : {}),
      }),
  })({ llm: args.deps.llm });
  const worker = createRuntimeJobWorker({
    store: args.store,
    eventBus: args.eventBus,
    tryWithCommitLock: args.sessionLock.tryWithLock!.bind(args.sessionLock),
    execute,
  });
  workers.add(worker);
  return worker;
}
