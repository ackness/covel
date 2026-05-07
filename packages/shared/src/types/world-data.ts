export type WorldDataSourceKind =
  | "yaml"
  | "json"
  | "markdown"
  | "text"
  | "media";

export type WorldDataMergeMode = "replace" | "skipExisting";

export type WorldDataEffect = "characters";

export type WorldDataKey = "id" | "characterId" | "filename" | string;

export interface WorldDataSourceDescriptor {
  readonly kind: WorldDataSourceKind;
  readonly path: string;
  readonly schema?: string;
  readonly to: string;
  readonly key?: WorldDataKey;
  readonly indexTo?: string;
  readonly effects?: readonly WorldDataEffect[];
  readonly enabled?: boolean;
  readonly locale?: string;
  readonly merge?: WorldDataMergeMode;
  readonly after?: string | readonly string[];
}

export interface WorldDataDescriptor {
  readonly schemaVersion: 1;
  readonly sources: Readonly<Record<string, WorldDataSourceDescriptor>>;
}

export interface WorldDataDiagnosticCounts {
  readonly info: number;
  readonly warning: number;
  readonly error: number;
}

export interface WorldDataSourceSummary {
  readonly id: string;
  readonly digest: string;
  readonly target: string;
  readonly schema?: string;
  readonly importedAt?: string;
  readonly order: number;
  readonly origin: "world" | "override";
  readonly overridden?: boolean;
  readonly diagnostics: WorldDataDiagnosticCounts;
}

export interface WorldDataMetadataSummary {
  readonly schemaVersion: 1;
  readonly sources: readonly WorldDataSourceSummary[];
}
