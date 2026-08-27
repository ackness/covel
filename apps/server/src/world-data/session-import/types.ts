import type {
  CharacterRecord,
  DataStore,
  MediaStore,
  StoreTransaction,
} from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { ParsedWorldDataTarget } from "../target-uri.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";

export type PluginDataTarget = Extract<
  ParsedWorldDataTarget,
  { kind: "plugin-data" }
>;

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
}

/** Read-only sync plan prepared before entering the session mutation lock. */
export interface PreparedWorldDataSync {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly plan: ImportPlan;
}

export interface WorldDataImportedMediaRef {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly cleanupOnFailure: boolean;
}

export interface WorldDataImportPreflightDeps {
  readonly activePlugins?: readonly string[];
  readonly registry?: Pick<PluginRegistry, "get">;
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

export interface ImportWorldDataForSessionOptions {
  // Accepts a transaction-scoped view so the session-create route can run the
  // whole import inside `store.withTransaction`. A full `DataStore` is still
  // assignable (it is a superset of `StoreTransaction`).
  readonly store: StoreTransaction;
  readonly mediaStore?: MediaStore;
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight?: WorldDataImportPreflightDeps;
  readonly deferMediaFinalize?: boolean;
  /** Session locale — selects `<name>.<lang>.<ext>` source variants when present. */
  readonly locale?: string;
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
      readonly diagnostics: readonly WorldDataDiagnostic[];
      readonly plan: ImportPlan;
      /** Media assets materialized before the database transaction opens. */
      readonly mediaRefs: readonly WorldDataImportedMediaRef[];
    };

export interface PrepareWorldDataImportForSessionOptions {
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
