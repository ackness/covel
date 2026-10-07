import type { I18nText } from "./extension-points.js";
import type { JsonValue } from "./types.js";

export type DimensionValueType =
  "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

/** The supported, closed JSON Schema vocabulary for authored dimension values. */
export interface DimensionValueSchema {
  readonly type?: DimensionValueType | readonly DimensionValueType[];
  /** Display label; may be localized. */
  readonly title?: I18nText;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly items?: DimensionValueSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, DimensionValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | DimensionValueSchema;
  readonly "x-i18n"?: boolean;
  /** Display labels for scalar enum members, keyed by `String(member)`. */
  readonly "x-enumLabels"?: Readonly<Record<string, I18nText>>;
}

export interface WorldDimensionDefinition {
  readonly name: I18nText;
  readonly description?: I18nText;
  readonly schema: DimensionValueSchema;
  readonly initialValue: JsonValue;
  readonly updateRule?: I18nText;
}

export type WorldDimensions = Readonly<
  Record<string, WorldDimensionDefinition>
>;

export interface DimensionSource {
  readonly resultId: string;
  readonly turnNumber: number;
}

/** Definition and current value share one revision and one atomic stored record. */
export interface DimensionRecord {
  readonly definition: WorldDimensionDefinition;
  readonly value: JsonValue;
  readonly version: number;
  readonly lastTrackedSource?: DimensionSource;
}

/** Public read contract deliberately excludes initial values and maintenance rules. */
export interface DimensionSnapshotEntry {
  readonly name: I18nText;
  readonly description?: I18nText;
  readonly schema: DimensionValueSchema;
  readonly value: JsonValue;
  readonly version: number;
}

export type DimensionSnapshot = Readonly<
  Record<string, DimensionSnapshotEntry>
>;

export type DimensionSettlementStatus =
  "pending-settlement" | "settled" | "no-change" | "manual" | "skipped";

export interface DimensionSettlementReceipt {
  readonly source: DimensionSource;
  readonly status: DimensionSettlementStatus;
  readonly readVersions: Readonly<Record<string, number>>;
  readonly definitions: WorldDimensions;
  readonly sourceTurnId: string;
  readonly version: number;
  readonly error?: string;
}

export interface DimensionUpdate {
  readonly id: string;
  readonly expectedVersion: number;
  readonly value: JsonValue;
  readonly reason?: string;
}

export interface DimensionInitializePayload {
  readonly definitions: WorldDimensions;
}

export interface DimensionUpdatePayload {
  readonly updates: readonly DimensionUpdate[];
  readonly source?: DimensionSource;
  readonly readVersions?: Readonly<Record<string, number>>;
  /** Empty updates still require an explicit successful or player resolution. */
  readonly settlement?: "no-change" | "manual" | "skipped";
}

export interface DimensionRecovery {
  readonly editorRuntimeId: string;
  readonly trackerRuntimeId: string;
}
export type DimensionSettlementSummary = Pick<
  DimensionSettlementReceipt,
  "source" | "status" | "sourceTurnId" | "error" | "version"
>;
