import type {
  CharacterRecord,
  DataStore,
  MediaStore,
  StoreTransaction,
} from "@covel/store";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
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

export interface ImportPlan {
  readonly writes: readonly PlannedWrite[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly mergeEvents: readonly MergeEvent[];
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
  readonly getPluginEntry?: (
    pluginId: string,
  ) => PluginRegistryEntry | undefined;
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
}

export interface ImportWorldDataForSessionResult {
  readonly imported: boolean;
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly planned: number;
  readonly written: number;
  readonly skipped: number;
  readonly mediaRefs: readonly WorldDataImportedMediaRef[];
}

export interface PreflightWorldDataForSessionOptions {
  readonly sessionId: string;
  readonly worldId: string | undefined;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly now: string;
  readonly preflight?: WorldDataImportPreflightDeps;
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
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly deferMediaFinalize?: boolean;
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
