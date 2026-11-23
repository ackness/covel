/**
 * Declarative Config Flow registry and state-machine run engine for instance
 * plugins (`covel.registerConfigFlow(flowId, definition)`).
 *
 * Security & concurrency invariants:
 * - Every run has a unique ID, bounded lifetime (`ttlMs`), and serialized
 *   per-run transition queue so concurrent loopback callbacks, manual pastes,
 *   device polling, and `DELETE` cancellations cannot race.
 * - Submitted `secret` field values and raw `callbackUrl` values are passed to
 *   the plugin handler and are NEVER retained in `ConfigFlowRunSnapshot`.
 * - Active loopback listeners close immediately on transition, cancellation,
 *   expiry, plugin reload, or host shutdown.
 */

import { randomUUID } from "node:crypto";
import type {
  PluginConfigFlowContext,
  PluginConfigFlowDefinition,
  PluginConfigFlowStartInput,
  PluginConfigFlowStepInput,
} from "@covel/runtime";
import {
  configFlowIdSchema,
  configFlowStepSchema,
  type ConfigFlowRunSnapshot,
  type ConfigFlowStep,
} from "@covel/shared/platform";
import {
  matchesLoopbackState,
  type LoopbackCallbackSession,
} from "../../../trust/loopback-callback.js";

export type ConfigFlowHttpStatus =
  400 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500;

export class ConfigFlowError extends Error {
  constructor(
    readonly status: ConfigFlowHttpStatus,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigFlowError";
  }
}

export interface ConfigFlowDefinitionEntry {
  readonly pluginId: string;
  readonly flowId: string;
  readonly definition: PluginConfigFlowDefinition;
}

export type ConfigFlowContextFactory = (args: {
  readonly pluginId: string;
  readonly flowId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly onLoopbackStarted: (session: LoopbackCallbackSession) => void;
}) => PluginConfigFlowContext;

export interface ConfigFlowEngine {
  register(
    pluginId: string,
    flowId: string,
    definition: PluginConfigFlowDefinition,
  ): () => void;
  get(pluginId: string, flowId: string): ConfigFlowDefinitionEntry | undefined;
  replacePlugin<T>(pluginId: string, fn: () => T): T;
  start(
    pluginId: string,
    flowId: string,
    input: PluginConfigFlowStartInput,
    buildContext: ConfigFlowContextFactory,
    requestSignal?: AbortSignal,
  ): Promise<ConfigFlowRunSnapshot>;
  getRun(
    pluginId: string,
    flowId: string,
    runId: string,
    buildContext: ConfigFlowContextFactory,
    requestSignal?: AbortSignal,
  ): Promise<ConfigFlowRunSnapshot>;
  step(
    pluginId: string,
    flowId: string,
    runId: string,
    payload: PluginConfigFlowStepInput,
    buildContext: ConfigFlowContextFactory,
    requestSignal?: AbortSignal,
  ): Promise<ConfigFlowRunSnapshot>;
  cancel(
    pluginId: string,
    flowId: string,
    runId: string,
    buildContext?: ConfigFlowContextFactory,
  ): Promise<ConfigFlowRunSnapshot>;
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT_RUNS = 50;
const COMPLETED_RETENTION_MS = 60_000;
const DEFAULT_IMPORT_MAX_BYTES = 262_144;
const HARD_IMPORT_MAX_BYTES = 1_048_576;

interface InternalFlowRun {
  readonly runId: string;
  readonly pluginId: string;
  readonly flowId: string;
  readonly definition: PluginConfigFlowDefinition;
  readonly createdAt: string;
  updatedAt: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly abortController: AbortController;
  status: ConfigFlowRunSnapshot["status"];
  step: ConfigFlowStep;
  loopbackSession?: LoopbackCallbackSession;
}

function definitionKey(pluginId: string, flowId: string): string {
  return `${pluginId}\0${flowId}`;
}

function toSnapshot(run: InternalFlowRun): ConfigFlowRunSnapshot {
  return {
    runId: run.runId,
    pluginId: run.pluginId,
    flowId: run.flowId,
    status: run.status,
    step: structuredClone(run.step),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    expiresAt: run.expiresAt,
  };
}

function validateStep(raw: unknown): ConfigFlowStep {
  const parsed = configFlowStepSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigFlowError(
      500,
      "invalid_flow_step",
      `Flow returned an invalid step: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "step"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function nextStatusForStep(
  step: ConfigFlowStep,
): ConfigFlowRunSnapshot["status"] {
  if (step.kind === "done") return "completed";
  if (step.kind === "error") return "failed";
  return "active";
}

export function createConfigFlowEngine(options?: {
  readonly ttlMs?: number;
  readonly maxConcurrentRuns?: number;
  readonly now?: () => number;
}): ConfigFlowEngine {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxConcurrentRuns = options?.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS;
  const now = options?.now ?? Date.now;

  const definitions = new Map<string, ConfigFlowDefinitionEntry>();
  const runs = new Map<string, InternalFlowRun>();
  const runTails = new Map<string, Promise<void>>();
  let closed = false;

  const serializeRun = async <T>(
    runId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const previous = runTails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previous.then(
      () => current,
      () => current,
    );
    runTails.set(runId, nextTail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (runTails.get(runId) === nextTail) {
        runTails.delete(runId);
      }
    }
  };

  const closeLoopback = async (run: InternalFlowRun): Promise<void> => {
    const session = run.loopbackSession;
    run.loopbackSession = undefined;
    if (session) {
      await session.close().catch(() => {});
    }
  };

  const expireIfNeeded = async (run: InternalFlowRun): Promise<boolean> => {
    if (run.status === "active" && now() > run.expiresAtMs) {
      run.status = "expired";
      run.updatedAt = new Date(now()).toISOString();
      run.abortController.abort(new Error("Config flow run expired"));
      await closeLoopback(run);
      return true;
    }
    return run.status === "expired";
  };

  const pruneRuns = async (): Promise<void> => {
    const currentNow = now();
    for (const [id, run] of runs) {
      await expireIfNeeded(run);
      if (
        run.status !== "active" &&
        currentNow - Date.parse(run.updatedAt) > COMPLETED_RETENTION_MS
      ) {
        runs.delete(id);
      }
    }
  };

  const activeRunCount = (): number => {
    let count = 0;
    for (const run of runs.values()) {
      if (run.status === "active") count += 1;
    }
    return count;
  };

  const getOwnedRun = (
    pluginId: string,
    flowId: string,
    runId: string,
  ): InternalFlowRun => {
    const run = runs.get(runId);
    if (!run || run.pluginId !== pluginId || run.flowId !== flowId) {
      throw new ConfigFlowError(
        404,
        "flow_run_not_found",
        `Config flow run "${runId}" was not found for "${pluginId}/${flowId}"`,
      );
    }
    return run;
  };

  const buildCallSignal = (
    run: InternalFlowRun,
    requestSignal?: AbortSignal,
  ): AbortSignal =>
    requestSignal
      ? AbortSignal.any([run.abortController.signal, requestSignal])
      : run.abortController.signal;

  const makeRunContext = (
    run: InternalFlowRun,
    buildContext: ConfigFlowContextFactory,
    requestSignal?: AbortSignal,
  ): PluginConfigFlowContext =>
    buildContext({
      pluginId: run.pluginId,
      flowId: run.flowId,
      runId: run.runId,
      signal: buildCallSignal(run, requestSignal),
      onLoopbackStarted: (session) => {
        if (run.loopbackSession && run.loopbackSession !== session) {
          void run.loopbackSession.close().catch(() => {});
        }
        run.loopbackSession = session;
      },
    });

  const attachLoopbackAutoAdvance = (
    run: InternalFlowRun,
    buildContext: ConfigFlowContextFactory,
  ): void => {
    const session = run.loopbackSession;
    if (!session || run.status !== "active" || run.step.kind !== "browser") {
      return;
    }
    void session.waitForCallback().then(
      async (result) => {
        await serializeRun(run.runId, async () => {
          if (
            closed ||
            (await expireIfNeeded(run)) ||
            run.loopbackSession !== session ||
            run.status !== "active" ||
            run.step.kind !== "browser"
          ) {
            return;
          }
          try {
            await applyStepLocked(
              run,
              {
                stepId: run.step.stepId,
                callbackUrl: result.callbackUrl,
                data: { ...result.query },
              },
              buildContext,
            );
          } catch (error) {
            run.status = "failed";
            run.updatedAt = new Date(now()).toISOString();
            run.step = {
              kind: "error",
              code: "loopback_step_failed",
              title: "Authorization failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Callback handling failed",
              retryable: false,
            };
          }
        });
      },
      () => {},
    );
  };

  const applyValidatedStep = async (
    run: InternalFlowRun,
    nextStep: ConfigFlowStep,
    buildContext: ConfigFlowContextFactory,
  ): Promise<ConfigFlowRunSnapshot> => {
    run.step = nextStep;
    run.status = nextStatusForStep(nextStep);
    run.updatedAt = new Date(now()).toISOString();

    if (run.status !== "active") {
      await closeLoopback(run);
    } else if (nextStep.kind === "browser" && run.loopbackSession) {
      attachLoopbackAutoAdvance(run, buildContext);
    }
    return toSnapshot(run);
  };

  const applyStepLocked = async (
    run: InternalFlowRun,
    payload: PluginConfigFlowStepInput,
    buildContext: ConfigFlowContextFactory,
    requestSignal?: AbortSignal,
  ): Promise<ConfigFlowRunSnapshot> => {
    if (await expireIfNeeded(run)) {
      throw new ConfigFlowError(
        410,
        "flow_run_expired",
        "Configuration flow run has expired",
      );
    }
    if (run.status !== "active") {
      throw new ConfigFlowError(
        409,
        "flow_run_not_active",
        `Configuration flow run is already ${run.status}`,
      );
    }
    if (!("stepId" in run.step) || run.step.stepId !== payload.stepId) {
      throw new ConfigFlowError(
        409,
        "flow_step_mismatch",
        `Expected active step "${"stepId" in run.step ? run.step.stepId : run.step.kind}", got "${payload.stepId}"`,
      );
    }

    if (run.step.kind === "import") {
      const maxAllowed = Math.min(
        HARD_IMPORT_MAX_BYTES,
        run.step.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES,
      );
      const encodedBytes = Buffer.byteLength(
        JSON.stringify(payload.data ?? {}),
        "utf8",
      );
      const rawContentBytes =
        typeof payload.data?.content === "string"
          ? Buffer.byteLength(payload.data.content, "utf8")
          : 0;
      if (encodedBytes > maxAllowed || rawContentBytes > maxAllowed) {
        throw new ConfigFlowError(
          413,
          "payload_too_large",
          `Import payload exceeds maximum allowed ${maxAllowed} bytes`,
        );
      }
    }

    const callbackUrl =
      payload.callbackUrl ??
      (typeof payload.data?.callbackUrl === "string"
        ? payload.data.callbackUrl
        : undefined);
    const loopback = run.loopbackSession;
    const completingCallback =
      loopback !== undefined &&
      run.step.kind === "browser" &&
      !payload.cancelled;
    if (completingCallback) {
      const parsed = callbackUrl ? URL.parse(callbackUrl) : null;
      if (!parsed || !matchesLoopbackState(parsed, loopback.state)) {
        throw new ConfigFlowError(
          400,
          "invalid_callback_state",
          "The callback does not match this authorization flow",
        );
      }
    }
    await loopback?.close().catch(() => {});
    if (completingCallback && !loopback.canAccept()) {
      throw new ConfigFlowError(
        403,
        "capability_denied",
        "The authorization flow is no longer permitted",
      );
    }
    const ctx = makeRunContext(run, buildContext, requestSignal);
    const rawStep = await run.definition.step(
      {
        stepId: payload.stepId,
        ...(payload.data !== undefined ? { data: payload.data } : {}),
        ...(callbackUrl !== undefined ? { callbackUrl } : {}),
        ...(payload.cancelled !== undefined
          ? { cancelled: payload.cancelled }
          : {}),
      },
      ctx,
    );
    const nextStep = validateStep(rawStep);
    if (run.loopbackSession === loopback) run.loopbackSession = undefined;
    return applyValidatedStep(run, nextStep, buildContext);
  };

  return {
    register(
      pluginId: string,
      flowId: string,
      definition: PluginConfigFlowDefinition,
    ): () => void {
      const parsedId = configFlowIdSchema.safeParse(flowId);
      if (!parsedId.success) {
        throw new Error(
          parsedId.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      if (
        !definition ||
        typeof definition.start !== "function" ||
        typeof definition.step !== "function"
      ) {
        throw new Error(
          `config flow "${flowId}" must provide start() and step() handlers`,
        );
      }
      const key = definitionKey(pluginId, flowId);
      if (definitions.has(key)) {
        throw new Error(
          `config flow "${flowId}" is already registered in plugin "${pluginId}"`,
        );
      }
      const entry: ConfigFlowDefinitionEntry = {
        pluginId,
        flowId,
        definition,
      };
      definitions.set(key, entry);
      return () => {
        if (definitions.get(key) === entry) {
          definitions.delete(key);
        }
      };
    },

    get(
      pluginId: string,
      flowId: string,
    ): ConfigFlowDefinitionEntry | undefined {
      return definitions.get(definitionKey(pluginId, flowId));
    },

    replacePlugin<T>(pluginId: string, fn: () => T): T {
      const saved: Array<[string, ConfigFlowDefinitionEntry]> = [];
      for (const [key, entry] of definitions) {
        if (entry.pluginId === pluginId) {
          saved.push([key, entry]);
          definitions.delete(key);
        }
      }
      try {
        const result = fn();
        for (const run of runs.values()) {
          if (run.pluginId === pluginId && run.status === "active") {
            run.status = "cancelled";
            run.updatedAt = new Date(now()).toISOString();
            run.abortController.abort(new Error("Plugin reloaded"));
            void closeLoopback(run);
          }
        }
        return result;
      } catch (error) {
        for (const [key, entry] of saved) {
          definitions.set(key, entry);
        }
        throw error;
      }
    },

    async start(
      pluginId: string,
      flowId: string,
      input: PluginConfigFlowStartInput,
      buildContext: ConfigFlowContextFactory,
      requestSignal?: AbortSignal,
    ): Promise<ConfigFlowRunSnapshot> {
      if (closed) {
        throw new ConfigFlowError(
          409,
          "flow_engine_closed",
          "Configuration flow engine is closed",
        );
      }
      const entry = definitions.get(definitionKey(pluginId, flowId));
      if (!entry) {
        throw new ConfigFlowError(
          404,
          "flow_not_found",
          `Config flow "${flowId}" is not registered for plugin "${pluginId}"`,
        );
      }
      await pruneRuns();
      if (activeRunCount() >= maxConcurrentRuns) {
        throw new ConfigFlowError(
          429,
          "too_many_flow_runs",
          "Too many concurrent configuration flow runs",
        );
      }

      const startedMs = now();
      const createdAt = new Date(startedMs).toISOString();
      const expiresAtMs = startedMs + ttlMs;
      const runId = randomUUID();
      const run: InternalFlowRun = {
        runId,
        pluginId,
        flowId,
        definition: entry.definition,
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        abortController: new AbortController(),
        status: "active",
        step: { kind: "error", title: "Initializing", message: "Initializing" },
      };

      const ctx = makeRunContext(run, buildContext, requestSignal);
      let firstStep: ConfigFlowStep;
      try {
        firstStep = validateStep(await entry.definition.start(input, ctx));
      } catch (error) {
        await closeLoopback(run);
        throw error;
      }

      runs.set(runId, run);
      return applyValidatedStep(run, firstStep, buildContext);
    },

    async getRun(
      pluginId: string,
      flowId: string,
      runId: string,
      buildContext: ConfigFlowContextFactory,
      requestSignal?: AbortSignal,
    ): Promise<ConfigFlowRunSnapshot> {
      const run = getOwnedRun(pluginId, flowId, runId);
      return serializeRun(run.runId, async () => {
        if (await expireIfNeeded(run)) {
          return toSnapshot(run);
        }
        if (
          run.status === "active" &&
          run.step.kind === "device" &&
          run.definition.poll
        ) {
          const ctx = makeRunContext(run, buildContext, requestSignal);
          const polled = await run.definition.poll(ctx);
          if (polled !== null && polled !== undefined) {
            return applyValidatedStep(run, validateStep(polled), buildContext);
          }
        }
        return toSnapshot(run);
      });
    },

    async step(
      pluginId: string,
      flowId: string,
      runId: string,
      payload: PluginConfigFlowStepInput,
      buildContext: ConfigFlowContextFactory,
      requestSignal?: AbortSignal,
    ): Promise<ConfigFlowRunSnapshot> {
      const run = getOwnedRun(pluginId, flowId, runId);
      return serializeRun(run.runId, () =>
        applyStepLocked(run, payload, buildContext, requestSignal),
      );
    },

    async cancel(
      pluginId: string,
      flowId: string,
      runId: string,
      buildContext?: ConfigFlowContextFactory,
    ): Promise<ConfigFlowRunSnapshot> {
      const run = getOwnedRun(pluginId, flowId, runId);
      return serializeRun(run.runId, async () => {
        await expireIfNeeded(run);
        if (run.status === "active") {
          run.status = "cancelled";
          run.updatedAt = new Date(now()).toISOString();
          run.abortController.abort(new Error("Config flow run cancelled"));
          await closeLoopback(run);
          if (run.definition.cancel && buildContext) {
            const ctx = makeRunContext(run, buildContext);
            await Promise.resolve(run.definition.cancel(ctx)).catch(() => {});
          }
        } else {
          await closeLoopback(run);
        }
        return toSnapshot(run);
      });
    },

    async close(): Promise<void> {
      closed = true;
      const allRuns = [...runs.values()];
      for (const run of allRuns) {
        if (run.status === "active") {
          run.status = "cancelled";
          run.updatedAt = new Date(now()).toISOString();
        }
        run.abortController.abort(new Error("Host shutting down"));
        await closeLoopback(run);
      }
      runs.clear();
      definitions.clear();
    },
  };
}
