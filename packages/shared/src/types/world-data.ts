export type WorldDataSourceKind =
  "yaml" | "json" | "markdown" | "text" | "media";

export type WorldDataMergeMode = "replace" | "skipExisting";

export type WorldDataEffect = "characters" | "projections";

export type WorldDataKey = "id" | "characterId" | "filename" | string;

/** `hidden` data stays out of prompts and public APIs until a plugin reveals it. */
export type WorldDataVisibility = "public" | "hidden";

export interface WorldDataSourceDescriptor {
  readonly kind: WorldDataSourceKind;
  readonly path: string;
  readonly schema?: string;
  readonly to: string;
  readonly key?: WorldDataKey;
  /** Stable identities for nested object arrays in locale overlays. */
  readonly localeArrayKeys?: readonly string[];
  readonly indexTo?: string;
  readonly effects?: readonly WorldDataEffect[];
  readonly enabled?: boolean;
  readonly locale?: string;
  readonly merge?: WorldDataMergeMode;
  readonly after?: string | readonly string[];
  readonly visibility?: WorldDataVisibility;
}

export interface WorldDataDescriptor {
  readonly sources: Readonly<Record<string, WorldDataSourceDescriptor>>;
}

/**
 * A world's descriptor as written: each entry changes the conventional source
 * with its `path`, or adds a source (then with `kind` and `to`).
 */
export interface WorldDataDescriptorFile {
  readonly sources: Readonly<
    Record<
      string,
      Partial<WorldDataSourceDescriptor> &
        Pick<WorldDataSourceDescriptor, "path">
    >
  >;
}

/**
 * A world-data import finding the player is shown: data of the world that
 * did not reach the session, say because no enabled plugin receives it. The
 * message is the importer's, in English, like the session prep preflight;
 * `code`, when present, lets the client say it in the player's language.
 */
export interface WorldDataImportNotice {
  readonly level: "warning" | "error";
  readonly sourceId?: string;
  readonly code?: string;
  readonly message: string;
}

/** What importing world data for plugins that joined a session did. */
export interface WorldDataReceiverImport {
  /** The joined plugins that received data for the first time. */
  readonly receivers: readonly string[];
  /** Rows written for them. */
  readonly imported: number;
  /** Rows left as they were because the session changed them. */
  readonly conflicts: number;
  /** The import's findings for the session's current plugins. */
  readonly notices: readonly WorldDataImportNotice[];
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
