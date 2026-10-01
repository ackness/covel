import type { JsonValue } from "./types.js";

/** Structural SDK mirror; the standalone SDK does not import the kernel. */
export type ExtensionWorldI18nText = string | Record<string, string>;
export type ExtensionDimensionValueType =
  "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";
export interface ExtensionDimensionValueSchema {
  readonly type?:
    ExtensionDimensionValueType | readonly ExtensionDimensionValueType[];
  readonly title?: ExtensionWorldI18nText;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly items?: ExtensionDimensionValueSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, ExtensionDimensionValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ExtensionDimensionValueSchema;
  readonly "x-i18n"?: boolean;
  readonly "x-enumLabels"?: Readonly<Record<string, ExtensionWorldI18nText>>;
}
export interface ExtensionDimensionDefinition {
  readonly name: ExtensionWorldI18nText;
  readonly description?: ExtensionWorldI18nText;
  readonly schema: ExtensionDimensionValueSchema;
  readonly initialValue: JsonValue;
  readonly updateRule?: ExtensionWorldI18nText;
}
export type ExtensionWorldDimensions = Readonly<
  Record<string, ExtensionDimensionDefinition>
>;
export interface ExtensionDimensionSnapshotEntry {
  readonly name: ExtensionWorldI18nText;
  readonly description?: ExtensionWorldI18nText;
  readonly schema: ExtensionDimensionValueSchema;
  readonly value: JsonValue;
  readonly version: number;
}
export type ExtensionDimensionSnapshot = Readonly<
  Record<string, ExtensionDimensionSnapshotEntry>
>;
