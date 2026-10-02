import type { LLMAdapter, TurnExecutorDeps } from "@covel/runtime";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import type { GatewayOptions } from "@covel/ai-provider";

/** Opaque request services retain keys and slot overlays without serializing them. */
export interface RuntimeJobServices {
  readonly llm: LLMAdapter;
  /** Request services must resolve usable credentials for the queued target model. */
  readonly canRun?: (model: string | undefined) => boolean;
  readonly gateway?: PluginRuntimeGateway;
  readonly compactor?: TurnExecutorDeps["compactor"];
  /**
   * The request's LLM options (keys, slot overrides, role bindings). The job's
   * model is resolved and executed under them, never under whichever request
   * happens to wake the worker. Absent for server services.
   */
  readonly llmOptions?: GatewayOptions;
}

export interface RuntimeJobCredentialKey {
  readonly jobId: string;
  readonly sessionId: string;
  readonly expectedSessionIncarnation: string;
}

interface CredentialEntry {
  readonly key: RuntimeJobCredentialKey;
  readonly services: RuntimeJobServices;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A bounded in-process handoff; no session-wide credentials or storage writes. */
export function createRuntimeJobCredentials(
  options: {
    readonly defaultTtlMs?: number;
    readonly now?: () => number;
  } = {},
) {
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
    throw new RangeError("credential defaultTtlMs must be positive");
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, CredentialEntry>();
  const remove = (id: string) => {
    const entry = entries.get(id);
    if (entry) clearTimeout(entry.timer);
    entries.delete(id);
  };
  const matches = (entry: CredentialEntry, key: RuntimeJobCredentialKey) =>
    entry.key.sessionId === key.sessionId &&
    entry.key.expectedSessionIncarnation === key.expectedSessionIncarnation;
  const prune = () => {
    const current = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= current) remove(id);
    }
  };
  return {
    /** Register before publishing a queued job; discard on transaction rollback. */
    register(
      key: RuntimeJobCredentialKey,
      services: RuntimeJobServices,
      ttlMs = defaultTtlMs,
    ): void {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("credential ttlMs must be positive");
      }
      prune();
      const existing = entries.get(key.jobId);
      // Neither another request nor a replaced session may overwrite a handoff.
      if (existing) return;
      const timer = setTimeout(() => remove(key.jobId), ttlMs);
      timer.unref?.();
      entries.set(key.jobId, {
        key: { ...key },
        services,
        expiresAt: now() + ttlMs,
        timer,
      });
    },
    /** Only call after authenticating this request against the live session. */
    provide(
      jobs: readonly RuntimeJobCredentialKey[],
      services: RuntimeJobServices,
      ttlMs = defaultTtlMs,
    ): void {
      for (const job of jobs) this.register(job, services, ttlMs);
    },
    peek(key: RuntimeJobCredentialKey): RuntimeJobServices | undefined {
      prune();
      const entry = entries.get(key.jobId);
      return entry && matches(entry, key) ? entry.services : undefined;
    },
    take(key: RuntimeJobCredentialKey): RuntimeJobServices | undefined {
      const services = this.peek(key);
      if (services) remove(key.jobId);
      return services;
    },
    discard(key: RuntimeJobCredentialKey): void {
      const entry = entries.get(key.jobId);
      if (entry && matches(entry, key)) remove(key.jobId);
    },
    clearSession(sessionId: string): void {
      for (const [id, entry] of entries) {
        if (entry.key.sessionId === sessionId) remove(id);
      }
    },
    clear(): void {
      for (const id of entries.keys()) remove(id);
    },
    get size(): number {
      prune();
      return entries.size;
    },
  };
}
