/**
 * Scheduling IR types for the runtime-scheduling redesign.
 *
 * Two-level IR: the loader normalizes each `RuntimeManifest` into a
 * `NormalizedRuntimeSpec` (per-manifest, no session resolution), and the
 * session scheduler resolves the active set into a `SessionExecutionPlan`
 * (providers resolved, DAG layered). Schedulers, validators, and traces
 * consume only this IR; all legacy-compat mapping (priority band folding,
 * `upstreamRequired` aliasing, scheduled→auto folding for setup) is
 * centralized at the loader exit.
 */

import type { TriggerConfig } from "./plugin.js";

// ── JSON wire value ──────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;

/**
 * The only value shape allowed across runtime boundaries (activation
 * payloads, binding values, exports, job data). Binary data never flows
 * inline — media is referenced via MediaRef wire objects (a managed subset
 * of JsonValue) whose bytes live in the MediaStore.
 */
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

// ── Stage axis ───────────────────────────────────────────────────

/**
 * Coarse-grained named phases replacing the numeric priority bands:
 * setup (0–99), pre-turn (100–499), narrative (500), post-turn (501–999),
 * audit (1000). Strict barrier between stages; intra-stage order comes
 * exclusively from dependencies.
 */
export type Stage = "setup" | "pre-turn" | "narrative" | "post-turn" | "audit";

export const STAGE_ORDER: readonly Stage[] = [
  "setup",
  "pre-turn",
  "narrative",
  "post-turn",
  "audit",
];

// ── Dependency axis ──────────────────────────────────────────────

export type DependencyCardinality = "one" | "all";

/**
 * Gate scope for `needs` entries.
 * - `turn`: target succeeded in this execution's visible set.
 * - `session`: target is `done` in the persistent snapshot frozen at
 *   execution start (setup runtimes only; a done produced by this execution
 *   becomes visible to the NEXT execution).
 */
export type NeedsScope = "turn" | "session";

/**
 * One `after` / `needs` entry. A bare string is shorthand for
 * `{ runtime }`. `cardinality` applies to capability refs only;
 * `scope` applies to `needs` entries only (loader-enforced).
 */
export type DependencyRef =
  | string
  | { readonly runtime: string; readonly scope?: NeedsScope }
  | {
      readonly capability: string;
      readonly cardinality?: DependencyCardinality;
      readonly scope?: NeedsScope;
    };

// ── Data bindings ────────────────────────────────────────────────

export type BindingSource =
  | { readonly runtime: string }
  | {
      readonly capability: string;
      readonly cardinality?: DependencyCardinality;
    };

/**
 * A typed same-execution data binding (`inputs.<name>`). `required: true`
 * implies `needs(turn)`; `false` implies `after`. `select` is an RFC 6901
 * JSON Pointer into the producer's success value; `accepts` is a
 * runtime-dir-relative JSON Schema path validating the final injected value.
 */
export interface RuntimeBinding {
  readonly from: BindingSource;
  readonly select?: string;
  readonly required?: boolean;
  readonly accepts?: string;
}

/**
 * Provenance wrapper for an injected binding value (02 §3.2). `accepts`
 * validates the business value BEFORE this wrapper (`value` for `one`,
 * `items.map(i => i.value)` for `all`) — metadata never attaches to the bare
 * value, so a value object that itself carries a `source` field cannot clash.
 */
export interface InputSource {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly resultId: string;
}

export type InputSlot<T extends JsonValue = JsonValue> =
  | {
      readonly cardinality: "one";
      readonly value: T;
      readonly source: InputSource;
    }
  | {
      readonly cardinality: "all";
      readonly items: readonly {
        readonly value: T;
        readonly source: InputSource;
      }[];
    };

/**
 * Cross-execution consumption of a producer's persisted `recordAs` export
 * (declared inside `input.inject` with `kind: runtime-export`). The consumer
 * reads the latest revision committed before this execution started.
 */
export interface RuntimeExportBinding {
  readonly kind: "runtime-export";
  readonly name: string;
  readonly from: BindingSource;
  readonly recordAs: string;
  readonly accepts?: string;
  readonly required?: boolean;
}

// ── Effects declaration ──────────────────────────────────────────

/**
 * Namespaced resource keys for read/write-set based parallel hazard
 * detection. `unknown:*` is the conservative global write — it intersects
 * with every read and write set.
 */
export type EffectResource =
  | "state:*"
  | "narrative:*"
  | "characters:*"
  | "assets:*"
  | "media:*"
  | "working-memory:*"
  | "lorebook:*"
  | "ui:*"
  | "interaction:*"
  | "unknown:*"
  | `plugin-data:self:${string}`
  | `event:${string}`
  | `http:${string}`;

/**
 * Optional explicit override of the derived read/write sets. When both
 * runtimes in a same-level pair opt into `parallelSafe`, only known pure
 * W/W intersections are exempted from hazard policy — never W/R or R/W.
 */
export interface EffectsDecl {
  readonly reads?: readonly EffectResource[];
  readonly writes?: readonly EffectResource[];
  readonly parallelSafe?: boolean;
}

// ── HTTP permission declaration ──────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/**
 * Declared upper bound for plugin-initiated HTTP through the Public Plugin
 * API. `origin` is a canonical HTTPS origin (no path/query/credentials);
 * methods default to GET only.
 */
export interface HttpPermissionDecl {
  readonly origin: string;
  readonly methods?: readonly HttpMethod[];
}

// ── Legacy job view projection (compat only) ─────────────────────

/**
 * Compat-period projection of kernel job-status records into a plugin's
 * legacy plugin-data view (e.g. the old `tracks` / `images` panels).
 * `keyFrom` / `valueFrom` are JSON Pointers into the full JobStatusEffect;
 * defaults are `jobId` and `/data`. Rejected by the strict authoring schema.
 */
export interface LegacyJobViewDecl {
  readonly jobIdPrefix?: string;
  readonly namespace: string;
  readonly keyFrom?: string;
  readonly valueFrom?: string;
}

// ── Normalized runtime spec (loader-level IR) ────────────────────

/** Declared trigger after normalization (e.g. setup scheduled→auto folding). */
export type TriggerSpec = TriggerConfig;

export type RuntimeResultFormat = "legacy" | "envelope-v1";

/**
 * Loader product: one per manifest, compat-normalized but not
 * session-resolved. Does NOT carry an activation source — how a runtime is
 * activated is a run-time property (`RuntimeActivation`).
 */
export interface NormalizedRuntimeSpec {
  readonly id: string;
  readonly pluginId: string;
  readonly declaredTrigger: TriggerSpec;
  /** Normalized from the legacy `execution: background` manifest field. */
  readonly backgroundWhenDetached: boolean;
  /** Handler may be replayed from a frozen activation boundary on approval-resume. */
  readonly suspensionSafe: boolean;
  /** Guides result parsing before normalization. Defaults to `legacy`. */
  readonly resultFormat: RuntimeResultFormat;
  /** Absent for event/manual runtimes and for legacy UI-only (no-priority) declarations. */
  readonly stage?: Stage;
  /** capability refs unresolved at this level. */
  readonly deps: {
    readonly after: readonly DependencyRef[];
    readonly needs: readonly DependencyRef[];
  };
  readonly bindings: Readonly<Record<string, RuntimeBinding>>;
  readonly exportBindings: Readonly<Record<string, RuntimeExportBinding>>;
  /** Runtime-dir-relative schema paths, containment-checked by the loader. */
  readonly schemas: {
    readonly activation?: string;
    readonly output?: string;
  };
  readonly outputRecordAs?: string;
  readonly effectsDecl?: EffectsDecl;
  readonly httpPermissions: readonly HttpPermissionDecl[];
  /** Compat-period only; always empty under the strict authoring schema. */
  readonly legacyJobViews: readonly LegacyJobViewDecl[];
  /** Which spec fields were derived from legacy manifest fields (diagnostics). */
  readonly provenance: { readonly legacyFields: readonly string[] };
}

// ── Execution identity ───────────────────────────────────────────

export type ExecutionOrigin =
  "player" | "continuation" | "manual" | "background" | "recursive" | "resume";

/**
 * Whether this execution's finalizer attempts to complete the player's
 * logical turn on committed non-suspended termination. Fixed at execution
 * creation from origin and persisted phase; never recomputed mid-run.
 */
export type CountPolicy = "none" | "complete-player-turn";

/**
 * Identity and counting responsibility of one scheduling pipeline run.
 * All runtime activations within an execution share it; suspension
 * snapshots must persist it completely. A resume inherits
 * `logicalTurnId` / `countPolicy` and only refreshes `executionId` / `origin`.
 */
export interface ExecutionContext {
  readonly executionId: string;
  readonly origin: ExecutionOrigin;
  readonly logicalTurnId?: string;
  readonly countPolicy: CountPolicy;
}

// ── Runtime activation (per-activation, run-time) ────────────────

/**
 * How a runtime was activated this time. `stage` sources are never
 * detached; `event` / `manual` sources detach according to
 * `backgroundWhenDetached`. Turn gates and bindings are evaluated against
 * `(spec, activation)` — a manual activation of a staged runtime ignores
 * its turn bindings without making the spec illegal.
 */
export interface RuntimeActivation {
  readonly source: "stage" | "event" | "manual";
  readonly detached: boolean;
  /** Normalized to `null` when the caller provides no payload. */
  readonly payload: JsonValue;
}

// ── Scheduling diagnostics ───────────────────────────────────────

export interface SchedulingDiagnostic {
  readonly code: string;
  readonly severity: "warn" | "error";
  readonly message: string;
  readonly runtimeId?: string;
  readonly data?: JsonValue;
}
