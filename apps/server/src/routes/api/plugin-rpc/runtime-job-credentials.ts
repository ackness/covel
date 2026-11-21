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

/** Upper bound on in-memory credential retention for queued jobs. */
export const MAX_CREDENTIAL_TTL_MS = 30 * 60_000;
/** Default ceiling on concurrently retained in-memory credential handoffs. */
export const DEFAULT_MAX_CREDENTIAL_ENTRIES = 1_024;

/** A bounded in-process handoff; no session-wide credentials or storage writes. */
export function createRuntimeJobCredentials(
  options: {
    readonly defaultTtlMs?: number;
    readonly maxTtlMs?: number;
    readonly maxEntries?: number;
    readonly now?: () => number;
  } = {},
) {
  const rawMaxTtlMs = options.maxTtlMs ?? MAX_CREDENTIAL_TTL_MS;
  if (!Number.isFinite(rawMaxTtlMs) || rawMaxTtlMs <= 0) {
    throw new RangeError("credential maxTtlMs must be positive");
  }
  const maxTtlMs = Math.min(rawMaxTtlMs, MAX_CREDENTIAL_TTL_MS);
  const rawDefaultTtlMs = options.defaultTtlMs ?? 300_000;
  if (!Number.isFinite(rawDefaultTtlMs) || rawDefaultTtlMs <= 0) {
    throw new RangeError("credential defaultTtlMs must be positive");
  }
  const defaultTtlMs = Math.min(rawDefaultTtlMs, maxTtlMs);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CREDENTIAL_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("credential maxEntries must be a positive integer");
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
      const effectiveTtlMs = Math.min(ttlMs, maxTtlMs);
      prune();
      const existing = entries.get(key.jobId);
      // Neither another request nor a replaced session may overwrite a handoff.
      if (existing) return;
      while (entries.size >= maxEntries) {
        const oldestId = entries.keys().next().value;
        if (oldestId === undefined) break;
        remove(oldestId);
      }
      const timer = setTimeout(() => remove(key.jobId), effectiveTtlMs);
      timer.unref?.();
      entries.set(key.jobId, {
        key: { ...key },
        services,
        expiresAt: now() + effectiveTtlMs,
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

export type RuntimeJobCredentials = ReturnType<
  typeof createRuntimeJobCredentials
>;

/** A queued job, as a credential hand-off names it. */
export interface CredentialHandoffJob {
  readonly job: { readonly maxQueueMs?: number };
  readonly credentialKey: RuntimeJobCredentialKey;
}

/**
 * One owner's hand-off of its provider services to the jobs it queues: a
 * request's, or a request-run job's for the jobs its commit queues.
 *
 * A commit registers the stage jobs it queues inside its transaction, so the
 * worker never claims one without them, and withdraws them when the commit
 * does not land. Jobs announced once their commit landed (event followers)
 * are handed off then. A job keeps the services for at most its queue time.
 */
export interface JobCredentialHandoff {
  /** Hand services to a job queued in the open transaction; tracked. */
  register(queued: CredentialHandoffJob): void;
  /** Hand services to jobs whose commit landed. */
  handOff(queued: readonly CredentialHandoffJob[]): void;
  /** Withdraw what `register` handed over, except to `keepJobIds`. */
  discard(keepJobIds?: ReadonlySet<string>): void;
  /** The jobs `register` handed services to and has not withdrawn. */
  readonly keys: readonly RuntimeJobCredentialKey[];
}

/**
 * Hand-off of `services` through `credentials`. Neither may be available
 * (no worker, or a request without its own provider keys); then nothing is
 * handed over and the worker runs the jobs with server services, if any.
 */
export function createJobCredentialHandoff(
  credentials: Pick<RuntimeJobCredentials, "register" | "discard"> | undefined,
  services: () => RuntimeJobServices | undefined,
): JobCredentialHandoff {
  const keys: RuntimeJobCredentialKey[] = [];
  const give = (queued: CredentialHandoffJob): boolean => {
    const provided = credentials ? services() : undefined;
    if (!credentials || !provided) return false;
    credentials.register(queued.credentialKey, provided, queued.job.maxQueueMs);
    return true;
  };
  return {
    register(queued) {
      if (give(queued)) keys.push(queued.credentialKey);
    },
    handOff(queued) {
      for (const job of queued) give(job);
    },
    discard(keepJobIds) {
      const kept = keys.filter((key) => keepJobIds?.has(key.jobId));
      for (const key of keys)
        if (!keepJobIds?.has(key.jobId)) credentials?.discard(key);
      keys.splice(0, keys.length, ...kept);
    },
    keys,
  };
}
