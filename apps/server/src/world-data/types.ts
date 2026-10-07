import type { WorldDataSourceDescriptor } from "@covel/shared";

export type WorldDataDiagnosticLevel = "info" | "warning" | "error";

export type WorldDataSourceOrigin = "world" | "override";

export interface WorldDataDiagnostic {
  readonly level: WorldDataDiagnosticLevel;
  readonly sourceId?: string;
  /** The file the finding is about, relative to the root it is read from. */
  readonly path?: string;
  readonly schema?: string;
  /** The place in `path`: a record such as `[2]`, or a path in a locale file. */
  readonly pointer?: string;
  readonly message: string;
  /** What the author can do about it. */
  readonly hint?: string;
  /** Set when a locale file's entry was ignored; `path` is that file. */
  readonly localeOverlay?: true;
}

export interface SourceFieldOrigin {
  readonly descriptorRoot: string;
  readonly origin: WorldDataSourceOrigin;
}

export interface MergedWorldDataSource {
  readonly id: string;
  readonly descriptor: WorldDataSourceDescriptor;
  readonly order: number;
  readonly origin: WorldDataSourceOrigin;
  readonly overridden: boolean;
  readonly pathOrigin: SourceFieldOrigin;
  readonly schemaOrigin?: SourceFieldOrigin;
  /**
   * The source named no schema; `descriptor.schema` is the one of its
   * destination. A contract that declares no schema is then not an error:
   * the source is imported without a check, as before.
   */
  readonly schemaImplicit?: true;
}

export interface OrderedWorldDataSource extends MergedWorldDataSource {
  /** In-memory portable records use the same import planner as file sources. */
  readonly inlineValue?: unknown;
  readonly resolvedOrder: number;
}

export interface LoadedWorldDataDescriptor {
  readonly sources: readonly OrderedWorldDataSource[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
}

export interface DigestResult {
  readonly digest: string;
  readonly size: number;
}
