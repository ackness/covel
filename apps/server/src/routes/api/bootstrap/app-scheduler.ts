import type { PluginScheduledTaskHandler } from "@covel/runtime";
import type { PluginRegistry } from "@covel/plugin-loader";
import { compareText } from "@covel/shared";
import {
  DEFAULT_SCHEDULER_TIMEOUT_MS,
  MIN_SCHEDULER_INTERVAL_MS,
  scheduledTaskIdSchema,
} from "@covel/shared/platform";
import type { DataStore } from "@covel/store";
import type { PermissionService } from "../../../trust/permission-service.js";
import type { SecretVault } from "../../../trust/secret-vault.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import { withCallSignal } from "./entry-http.js";
import {
  checkInstancePluginAllowed,
  isPluginCapabilityEffectivelyAllowed,
} from "./instance-plugins.js";
import {
  buildPluginInstanceSurface,
  packageHttpPermissions,
  pickPluginInstanceSurfaceFields,
} from "./plugin-entry-api.js";

const DEFAULT_MAX_BACKOFF_MS = 3_600_000;

interface RegisteredTask {
  readonly pluginId: string;
  readonly taskId: string;
  readonly handler: PluginScheduledTaskHandler;
}

export interface AppSchedulerDeps {
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly hostId?: string;
  readonly secretVault?: SecretVault;
  readonly getPermissionService: () => PermissionService | undefined;
  readonly getTrustedSources: () => TrustedSourceService | undefined;
}

export interface AppSchedulerOptions {
  readonly minIntervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly defaultTimeoutMs?: number;
}

export interface AppSchedulerRunOutcome {
  readonly status: "ran" | "skipped-overlap" | "denied" | "missing" | "failed";
}

export interface AppScheduler {
  register(
    pluginId: string,
    taskId: string,
    handler: PluginScheduledTaskHandler,
  ): () => void;
  replacePlugin<T>(pluginId: string, publish: () => T): T;
  armPlugin(pluginId: string): Promise<void>;
  scheduleOnce(
    pluginId: string,
    taskId: string,
    delayMs: number,
  ): Promise<void>;
  runTaskNow(pluginId: string, taskId: string): Promise<AppSchedulerRunOutcome>;
  stats(): {
    readonly runs: number;
    readonly failures: number;
    readonly skippedOverlap: number;
  };
  list(): ReadonlyArray<{
    readonly pluginId: string;
    readonly taskId: string;
    readonly failureCount: number;
  }>;
  close(): Promise<void>;
}

export function createAppScheduler(
  deps: AppSchedulerDeps,
  options?: AppSchedulerOptions,
): AppScheduler {
  const minIntervalMs = options?.minIntervalMs ?? MIN_SCHEDULER_INTERVAL_MS;
  const maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const defaultTimeoutMs =
    options?.defaultTimeoutMs ?? DEFAULT_SCHEDULER_TIMEOUT_MS;

  const handlers = new Map<string, RegisteredTask>();
  const recurringTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const onceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const failureCounts = new Map<string, number>();
  const pluginGenerations = new Map<string, number>();
  const activePlugins = new Set<string>();
  const inFlightControllers = new Map<string, AbortController>();
  const inFlightPromises = new Set<Promise<void>>();
  let runs = 0;
  let failures = 0;
  let skippedOverlap = 0;
  let closed = false;

  const taskKey = (pluginId: string, taskId: string) => `${pluginId}:${taskId}`;
  const generationOf = (pluginId: string) =>
    pluginGenerations.get(pluginId) ?? 0;

  const clearMapTimer = (
    map: Map<string, ReturnType<typeof setTimeout>>,
    key: string,
  ) => {
    const existing = map.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      map.delete(key);
    }
  };
  const clearRecurringTimer = (key: string) =>
    clearMapTimer(recurringTimers, key);
  const clearOnceTimer = (key: string) => clearMapTimer(onceTimers, key);

  const clearAllTimersForKey = (key: string) => {
    clearRecurringTimer(key);
    clearOnceTimer(key);
  };

  const clearPluginTimers = (pluginId: string) => {
    const prefix = `${pluginId}:`;
    for (const map of [recurringTimers, onceTimers]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) clearMapTimer(map, key);
      }
    }
  };

  const abortPluginInFlight = (pluginId: string, reason: Error) => {
    const prefix = `${pluginId}:`;
    for (const [key, ac] of [...inFlightControllers.entries()]) {
      if (key.startsWith(prefix) && !ac.signal.aborted) {
        ac.abort(reason);
      }
    }
  };

  async function isEligible(pluginId: string): Promise<boolean> {
    if (closed) return false;
    const allowed = await checkInstancePluginAllowed(
      {
        registry: deps.registry,
        permissionService: deps.getPermissionService(),
        trustedSources: deps.getTrustedSources(),
      },
      pluginId,
    );
    if (!allowed) return false;
    return isPluginCapabilityEffectivelyAllowed(
      deps.getPermissionService(),
      deps.registry,
      "app.scheduler",
      pluginId,
    );
  }

  function computeDelayMs(baseIntervalMs: number, count: number): number {
    const floor = Math.max(baseIntervalMs, minIntervalMs);
    const delay = count > 0 ? floor * Math.pow(2, Math.min(count, 10)) : floor;
    return Math.min(delay, maxBackoffMs);
  }

  function scheduleNextRun(
    pluginId: string,
    taskId: string,
    baseIntervalMs: number,
    delayMs: number,
    expectedGeneration: number,
    expectedRecord: RegisteredTask,
  ): void {
    const key = taskKey(pluginId, taskId);
    clearRecurringTimer(key);
    if (
      closed ||
      generationOf(pluginId) !== expectedGeneration ||
      handlers.get(key) !== expectedRecord
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (recurringTimers.get(key) === timer) {
        recurringTimers.delete(key);
      }
      if (
        closed ||
        generationOf(pluginId) !== expectedGeneration ||
        handlers.get(key) !== expectedRecord
      ) {
        return;
      }
      void runTaskNow(pluginId, taskId).then((outcome) => {
        if (
          !closed &&
          generationOf(pluginId) === expectedGeneration &&
          handlers.get(key) === expectedRecord &&
          outcome.status !== "denied"
        ) {
          scheduleRecurring(
            pluginId,
            taskId,
            baseIntervalMs,
            expectedGeneration,
            expectedRecord,
          );
        }
      });
    }, delayMs);
    timer.unref?.();
    recurringTimers.set(key, timer);
  }

  function scheduleRecurring(
    pluginId: string,
    taskId: string,
    baseIntervalMs: number,
    expectedGeneration: number,
    expectedRecord: RegisteredTask,
  ): void {
    const key = taskKey(pluginId, taskId);
    const delayMs = computeDelayMs(baseIntervalMs, failureCounts.get(key) ?? 0);
    scheduleNextRun(
      pluginId,
      taskId,
      baseIntervalMs,
      delayMs,
      expectedGeneration,
      expectedRecord,
    );
  }

  async function runTaskNow(
    pluginId: string,
    taskId: string,
  ): Promise<AppSchedulerRunOutcome> {
    if (closed) return { status: "denied" };
    const key = taskKey(pluginId, taskId);
    const registered = handlers.get(key);
    if (!registered) return { status: "missing" };
    const expectedGeneration = generationOf(pluginId);
    if (!(await isEligible(pluginId))) return { status: "denied" };
    if (
      closed ||
      generationOf(pluginId) !== expectedGeneration ||
      handlers.get(key) !== registered
    ) {
      return { status: "missing" };
    }
    if (activePlugins.has(pluginId)) {
      skippedOverlap++;
      return { status: "skipped-overlap" };
    }

    const entry =
      deps.registry.getCurrent(pluginId) ?? deps.registry.get(pluginId);
    const spec = entry?.packageManifest?.plugin.contributes?.schedules?.find(
      (item) => item.id === taskId,
    );
    const timeoutMs = spec?.timeoutMs ?? defaultTimeoutMs;
    const surface = buildPluginInstanceSurface({
      pluginId,
      pluginRegistry: deps.registry,
      store: deps.store,
      hostId: deps.hostId,
      secretVault: deps.secretVault,
      getPermissionService: deps.getPermissionService,
      httpPermissions: entry ? packageHttpPermissions(entry) : [],
    });

    activePlugins.add(pluginId);
    runs++;
    const ac = new AbortController();
    inFlightControllers.set(key, ac);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const task = Promise.resolve().then(() =>
      registered.handler({
        signal: ac.signal,
        pluginId,
        taskId,
        ...pickPluginInstanceSurfaceFields(surface),
        http: withCallSignal(surface.http, ac.signal),
      }),
    );
    const release = () => {
      if (inFlightControllers.get(key) === ac) {
        inFlightControllers.delete(key);
      }
      activePlugins.delete(pluginId);
      inFlightPromises.delete(tracker);
    };
    const tracker = task.then(release, release);
    inFlightPromises.add(tracker);

    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(ac.signal.reason);
        if (ac.signal.aborted) {
          reject(ac.signal.reason);
          return;
        }
        ac.signal.addEventListener("abort", onAbort, { once: true });
      });
      timeoutHandle = setTimeout(() => {
        if (!ac.signal.aborted) {
          ac.abort(
            new DOMException("Scheduled task timed out", "TimeoutError"),
          );
        }
      }, timeoutMs);
      timeoutHandle.unref?.();

      await Promise.race([task, aborted]);
      if (
        generationOf(pluginId) === expectedGeneration &&
        handlers.get(key) === registered
      ) {
        failureCounts.set(key, 0);
      }
      return { status: "ran" };
    } catch (error) {
      failures++;
      if (
        generationOf(pluginId) === expectedGeneration &&
        handlers.get(key) === registered
      ) {
        failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
      }
      console.warn(
        `[app-scheduler] task ${pluginId}/${taskId} failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return { status: "failed" };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  return {
    register(pluginId, taskId, handler) {
      const parsedId = scheduledTaskIdSchema.safeParse(taskId);
      if (!parsedId.success) {
        throw new Error(
          `registerScheduledTask: ${parsedId.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      if (typeof handler !== "function") {
        throw new Error("registerScheduledTask: handler must be a function");
      }
      const key = taskKey(pluginId, taskId);
      if (handlers.has(key)) {
        throw new Error(
          `Scheduled task "${taskId}" already registered for plugin "${pluginId}"`,
        );
      }
      const record: RegisteredTask = { pluginId, taskId, handler };
      handlers.set(key, record);
      failureCounts.set(key, 0);
      return () => {
        if (handlers.get(key) === record) {
          handlers.delete(key);
          clearAllTimersForKey(key);
          failureCounts.delete(key);
        }
      };
    },

    replacePlugin<T>(pluginId: string, publish: () => T): T {
      const previous = [...handlers.entries()].filter(
        ([, item]) => item.pluginId === pluginId,
      );
      for (const [key] of previous) {
        handlers.delete(key);
        failureCounts.delete(key);
      }
      try {
        const result = publish();
        pluginGenerations.set(pluginId, generationOf(pluginId) + 1);
        clearPluginTimers(pluginId);
        abortPluginInFlight(pluginId, new Error("Plugin reloaded"));
        return result;
      } catch (error) {
        for (const [key, item] of [...handlers.entries()]) {
          if (item.pluginId === pluginId) handlers.delete(key);
        }
        for (const [key, item] of previous) {
          handlers.set(key, item);
          failureCounts.set(key, 0);
        }
        throw error;
      }
    },

    async armPlugin(pluginId: string): Promise<void> {
      if (closed) return;
      const entry =
        deps.registry.getCurrent(pluginId) ?? deps.registry.get(pluginId);
      const specs = entry?.packageManifest?.plugin.contributes?.schedules ?? [];
      if (specs.length === 0) return;
      const expectedGeneration = generationOf(pluginId);
      if (!(await isEligible(pluginId))) return;
      if (closed || generationOf(pluginId) !== expectedGeneration) return;
      for (const spec of specs) {
        const key = taskKey(pluginId, spec.id);
        const record = handlers.get(key);
        if (!record) continue;
        if (spec.runOnStart) {
          scheduleNextRun(
            pluginId,
            spec.id,
            spec.intervalMs,
            0,
            expectedGeneration,
            record,
          );
        } else {
          scheduleRecurring(
            pluginId,
            spec.id,
            spec.intervalMs,
            expectedGeneration,
            record,
          );
        }
      }
    },

    async scheduleOnce(
      pluginId: string,
      taskId: string,
      delayMs: number,
    ): Promise<void> {
      if (closed) throw new Error("AppScheduler is closed");
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("scheduleOnce delayMs must be non-negative");
      }
      const key = taskKey(pluginId, taskId);
      const record = handlers.get(key);
      if (!record) {
        throw new Error(
          `Scheduled task "${taskId}" is not registered for "${pluginId}"`,
        );
      }
      const expectedGeneration = generationOf(pluginId);
      if (!(await isEligible(pluginId))) {
        throw new Error(
          `Capability "app.scheduler" is not permitted for plugin "${pluginId}"`,
        );
      }
      if (
        closed ||
        generationOf(pluginId) !== expectedGeneration ||
        handlers.get(key) !== record
      ) {
        return;
      }
      const effectiveDelay = Math.max(delayMs, minIntervalMs);
      clearOnceTimer(key);
      const timer = setTimeout(() => {
        if (onceTimers.get(key) === timer) {
          onceTimers.delete(key);
        }
        if (
          closed ||
          generationOf(pluginId) !== expectedGeneration ||
          handlers.get(key) !== record
        ) {
          return;
        }
        void runTaskNow(pluginId, taskId);
      }, effectiveDelay);
      timer.unref?.();
      onceTimers.set(key, timer);
    },

    runTaskNow,

    stats: () => ({ runs, failures, skippedOverlap }),

    list() {
      return [...handlers.values()]
        .map(({ pluginId, taskId }) => ({
          pluginId,
          taskId,
          failureCount: failureCounts.get(taskKey(pluginId, taskId)) ?? 0,
        }))
        .sort((a, b) =>
          compareText(`${a.pluginId}:${a.taskId}`, `${b.pluginId}:${b.taskId}`),
        );
    },

    async close(): Promise<void> {
      closed = true;
      for (const timer of recurringTimers.values()) clearTimeout(timer);
      recurringTimers.clear();
      for (const timer of onceTimers.values()) clearTimeout(timer);
      onceTimers.clear();
      for (const ac of inFlightControllers.values()) {
        if (!ac.signal.aborted) {
          ac.abort(new Error("Host shutting down"));
        }
      }
      if (inFlightPromises.size > 0) {
        await Promise.race([
          Promise.allSettled([...inFlightPromises]),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      handlers.clear();
      failureCounts.clear();
    },
  };
}
