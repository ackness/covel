import type {
  CharacterRecord,
  DataStore,
  MediaStore,
  StoreTransaction,
} from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { ResolvedPluginDataTarget } from "../contract-targets.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";

export type PluginDataTarget = ResolvedPluginDataTarget;

export type PlannedWrite =
  | {
      readonly kind: "plugin-data";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "lorebook";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly id: string;
      readonly pluginId: string;
      readonly content: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "character";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly key: string;
      readonly record: CharacterRecord;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    }
  | {
      readonly kind: "media-index";
      readonly target: string;
      readonly source: OrderedWorldDataSource;
      readonly sourceDigest: string;
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
      readonly value: unknown;
      readonly derivedFrom?: readonly string[];
    };

export type MergeEvent = {
  readonly level: "warning";
  readonly sourceId: string;
  readonly message: string;
};

/**
 * A projection output whose current plan is not authoritative because its
 * producer was skipped, rejected, timed out, or returned invalid data. Sync
 * must preserve older managed rows for this output until the producer can run
 * successfully again; this is distinct from a successful empty output.
 */
export interface DeferredProjectionOutput {
  readonly sourceId: string;
  readonly pluginId: string;
  readonly projectionId: string;
  readonly outputId: string;
}

export interface ImportPlan {
  readonly writes: readonly PlannedWrite[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly mergeEvents: readonly MergeEvent[];
  readonly deferredProjectionOutputs: readonly DeferredProjectionOutput[];
  /**
   * Missing receivers make these writes non-authoritative during sync.
   * `primary` preserves direct writes and their kernel effects while active
   * projections still reconcile independently; `all` preserves the whole source.
   */
  readonly deferredSources?: readonly {
    readonly sourceId: string;
    readonly scope: "primary" | "all";
  }[];
  /**
   * Dimensions the world declares that no active plugin can store. They are
   * left out: the session starts without them, and a sync leaves the
   * session's dimension records alone.
   */
  readonly skippedDimensions?: readonly string[];
}

/** Read-only sync plan prepared before entering the session mutation lock. */
export interface PreparedWorldDataSync {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly plan: ImportPlan;
  readonly dimensionOnly?: boolean;
}

export interface WorldDataImportedMediaRef {
  /** Private preparation claim, never a real session identity. */
  readonly temporarySessionId: string;
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
}

export interface WorldDataImportPreflightDeps {
  /** Session receiver selection; omit only when validating the full author catalogue. */
  readonly activePlugins?: readonly string[];
  readonly registry?: Pick<PluginRegistry, "get" | "getAll">;
  /**
   * Read-only planning never executes projection modules. Import/sync callers
   * leave this enabled and rely on `canExecuteProjection` for community code.
   */
  readonly executeProjectionHandlers?: boolean;
  /**
   * Explicit server-code approval check for community projection handlers.
   * Builtin handlers are trusted by their discovery source and do not call it.
   */
  readonly canExecuteProjection?: (pluginId: string) => boolean;
}

export interface ImportWorldDataForSessionResult {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly written: number;
  readonly skipped: number;
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}

/**
 * Immutable plan prepared before a session mutation lock / DB transaction.
 * It may contain paths and registry-derived declarations, so it is an
 * in-process value rather than a public API payload.
 */
export type PreparedWorldDataImport =
  | {
      readonly imported: false;
      readonly diagnostics: readonly WorldDataDiagnostic[];
    }
  | {
      readonly imported: true;
      /** Portable contract records do not replace embedded character/lore imports. */
      readonly portableOnly?: boolean;
      readonly diagnostics: readonly WorldDataDiagnostic[];
      readonly plan: ImportPlan;
      /** Media assets materialized before the database transaction opens. */
      readonly mediaRefs: readonly WorldDataImportedMediaRef[];
    };

/**
 * The part of the world record an import reads. The record is the world: its
 * dimensions, character schema and portable contract data are used as they
 * are, whatever the package files hold now. A package adds only the data the
 * record does not keep (its `data/` sources and media).
 */
export interface WorldDataImportRecord {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PrepareWorldDataImportForSessionOptions {
  /** The world's record; without one the world has no dimensions. */
  readonly world?: WorldDataImportRecord | null;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly mediaStore?: MediaStore;
  readonly preflight?: WorldDataImportPreflightDeps;
  readonly locale?: string;
}

export interface ApplyPreparedWorldDataImportForSessionOptions {
  readonly store: StoreTransaction;
  readonly mediaStore?: MediaStore;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly now: string;
  readonly prepared: PreparedWorldDataImport;
  readonly deferMediaFinalize?: boolean;
}

export interface PreflightWorldDataForSessionOptions {
  /** The world's record, as for {@link PrepareWorldDataImportForSessionOptions}. */
  readonly world?: WorldDataImportRecord | null;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight?: WorldDataImportPreflightDeps;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  readonly locale?: string;
}

export interface PreflightWorldDataForSessionResult {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly targets: readonly {
    readonly kind: PlannedWrite["kind"];
    readonly target: string;
    readonly sourceId: string;
    readonly pluginId?: string;
    readonly namespace?: string;
    readonly key?: string;
  }[];
}

export interface SyncWorldDataForSessionOptions {
  readonly dimensionOnly?: boolean;
  readonly store: DataStore;
  readonly mediaStore?: MediaStore;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight?: WorldDataImportPreflightDeps;
  readonly prepared?: PreparedWorldDataSync;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly deferMediaFinalize?: boolean;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  readonly locale?: string;
  /**
   * Sync only the rows of these plugins: their planned writes and their
   * ledger entries. A receiver that joins a running session gets its data
   * without touching what the others hold.
   */
  readonly receivers?: readonly string[];
}

export interface SyncWorldDataForSessionResult {
  readonly imported: boolean;
  readonly dryRun: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly conflicts: readonly {
    readonly target: string;
    readonly key?: string;
    readonly sourceId: string;
    readonly reason: "modified" | "missing";
  }[];
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}
