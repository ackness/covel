import type { WorldDataSourceDescriptor } from "@covel/shared";

export type WorldDataDiagnosticLevel = "info" | "warning" | "error";

export type WorldDataSourceOrigin = "world" | "override";

export interface WorldDataDiagnostic {
  readonly level: WorldDataDiagnosticLevel;
  readonly sourceId?: string;
  readonly path?: string;
  readonly schema?: string;
  readonly pointer?: string;
  readonly message: string;
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
}

export interface OrderedWorldDataSource extends MergedWorldDataSource {
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
