/** The API host's inputs and what it hands back to the composition root. */

import type { Hono, MiddlewareHandler } from "hono";
import type {
  PluginRegistry,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/plugin-loader";
import type { EventBus } from "@covel/events";
import type {
  DataStore,
  MediaStore,
  MediaStoreBackend,
  StoreBackend,
  VectorBackend,
} from "@covel/store";
import type { LLMAdapter } from "@covel/runtime";
import type { CompactorRunner } from "@covel/context";
import type { EmbedFn, MemorySystem } from "@covel/memory";
import type { MemoryIndexControl } from "../../../embedding-lock.js";
import type { SessionLock } from "../../../lib/session-lock.js";
import type { ApplicationWork } from "../../../application-work.js";
import type { HostProfile } from "../../../host-profile.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import type { RuntimeJobRecord } from "../plugin-rpc/jobs.js";
import type { RuntimeJobWorker } from "../plugin-rpc/runtime-job-worker.js";

export interface ApiBootstrapConfig {
  /** Share the composition root's request owner, or create one for an embedded API. */
  readonly applicationWork?: ApplicationWork;
  /** Path to plugins directory (e.g., 'plugins/'). Used when `pluginsDirs` is not provided. */
  readonly pluginsDir: string;
  /**
   * Optional ordered list of plugin directories (first wins on collision).
   * When provided, overrides `pluginsDir`. Typical desktop config:
   *   [bundledPluginsDir, userPluginsDir]
   * Bundled plugins take precedence so a user plugin with the same id cannot
   * shadow a core plugin.
   */
  readonly pluginsDirs?: readonly string[];
  /** Ordered world package directories. Later directories override earlier ones for session imports. */
  readonly worldsDirs?: readonly string[];
  /** Covel home directory for user world overrides. */
  readonly covelHome?: string;
  /** LLM adapter (real or mock). */
  readonly llmAdapter: LLMAdapter;
  /** Explicit server credential readiness; absent means request services are required. */
  readonly canRunRuntimeJobWithServerServices?: (input: {
    readonly job: RuntimeJobRecord;
    readonly model?: string;
  }) => boolean;
  /**
   * Optional narrow gateway facade exposed to function-runtime handlers
   * via `FunctionHandlerContext.gateway`. The server composition root
   * builds this from `createAiStack().gateway`; tests that don't need
   * LLM access from function runtimes can leave it out.
   */
  readonly pluginGateway?: PluginRuntimeGateway;
  /**
   * Plugin-facing utility surface (SSRF guard + retrying fetch) exposed
   * via `FunctionHandlerContext.utils`. Stateless singleton — typically
   * built from `@covel/ai-provider`'s `validateBaseUrlForPlugin` +
   * `fetchWithRetry` exports in the composition root.
   */
  readonly pluginUtils?: PluginRuntimeUtils;
  /** DataStore for all persistence. */
  readonly store: DataStore;
  /**
   * Active store backend identifier (e.g. `'sqlite'`, `'pg'`, `'memory'`).
   * Used by the health route to report the actual backend in use rather
   * than re-deriving it from environment variables.
   */
  readonly storeBackend: StoreBackend;
  /**
   * The deployment form the host resolved at start (`app.ts`). Every route
   * asks it through `hostProfileOf(c)`. Optional so a test can assemble the
   * API without one: requests then get the profile the environment and
   * `storeBackend` give at the time of the request.
   */
  readonly hostProfile?: HostProfile;
  /**
   * Optional embedding-lock helper. When provided, route handlers that
   * begin a turn (start_session, submit_actions, …) call it to lazily
   * register the session's embedding model in vector_models and lock
   * the session row. No-op when the store has no vector capability or
   * no embed slot is configured.
   */
  readonly ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  /**
   * Optional embedding configuration reader for the memory index routes
   * (`/api/sessions/:id/memory-index`). Ignored when `vectorBackend` is "none".
   */
  readonly memoryIndex?: MemoryIndexControl;
  /**
   * Optional embedding function for the semantic (vector) memory tier. When
   * provided AND the store supports vectors, the memory system upgrades
   * recall/archival from keyword to vector search and gains a real embed-on-
   * write ingestion path. The composition root builds it from
   * `createAiStack().gateway.embed`. Absent → keyword-only memory (unchanged).
   */
  readonly memoryEmbed?: EmbedFn;
  /**
   * Optional per-request middleware inserted AFTER the default dependency
   * injection middleware but BEFORE route handlers execute. Intended for
   * request-scoped overrides (e.g. swapping `llmAdapter` based on headers
   * that carry browser-defined custom slots or API keys).
   */
  readonly perRequestMiddleware?: readonly MiddlewareHandler[];
  /**
   * Per-session serializer used by turn-executing routes. When omitted,
   * `bootstrapApi()` installs an in-process `Map`-based lock which is
   * correct for single-node deployments (memory/sqlite, single PG pod).
   * Multi-pod PG deployments MUST pass a distributed implementation —
   * typically `createPgAdvisorySessionLock(sql)` from
   * `../../lib/pg-session-lock.ts` — so mutual exclusion is enforced
   * across processes. The implementation must also provide nonblocking
   * `tryWithLock` so durable recovery can distinguish live commits.
   */
  readonly sessionLock?: SessionLock;
  /**
   * Dedicated serializer for background vector-ingestion sweeps. PostgreSQL
   * deployments should inject a separate advisory-lock pool so slow embedding
   * calls cannot exhaust the user-turn lock pool.
   */
  readonly memoryIngestLock?: SessionLock;
  /**
   * Optional content-addressable media store backing `/api/media/:id`
   * and `ctx.media`. Composition roots that do not generate or serve
   * media (e.g. headless test harnesses) may leave this unset; the
   * route returns 503 in that case. See SPEC §5.1 (b)(g).
   */
  readonly mediaStore?: MediaStore;
  readonly mediaBackend?: MediaStoreBackend;
  readonly vectorBackend?: VectorBackend;
}

export interface ApiBootstrapResult {
  readonly trustedSources: TrustedSourceService;
  readonly memorySystem?: MemorySystem;
  readonly applicationWork: ApplicationWork;
  readonly app: Hono;
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly compactorRunner: CompactorRunner;
  readonly runtimeJobWorker: RuntimeJobWorker;
  /** Non-blocking startup scans; the host must drain these before closing storage. */
  readonly startupMaintenance: Promise<void>;
  /** Stop tool admission and drain cancelled callbacks before releasing dependencies. */
  readonly closeTools: () => Promise<void>;
  /** Unregister capabilities only after runtime and memory producers have stopped. */
  readonly closePluginEntries: () => Promise<void>;
  /**
   * Refresh the per-session tool override cache for `(create|update)-character`
   * so the next `executeTurn` exposes schema-typed `fields` to the LLM.
   * Idempotent and safe to call when no schema exists yet (it simply clears
   * the cache for that session).
   */
  readonly prepareToolsForSession: (sessionId: string) => Promise<void>;
}
