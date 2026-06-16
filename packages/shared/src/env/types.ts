/**
 * Shared types for the environment-variable registry.
 *
 * Kept in a dedicated module so the per-group definition files
 * (`env/groups/*.ts`) and the aggregating `registry-definitions.ts` can both
 * import them without a circular dependency.
 */

export type EnvValueType =
  | "boolean"
  | "enum"
  | "integer"
  | "path"
  | "secret"
  | "string"
  | "url";

export type EnvGroup =
  | "ai"
  | "desktop"
  | "feature"
  | "packaging"
  | "server"
  | "storage"
  | "test"
  | "web";

export type EnvStatus = "active" | "documented" | "packaging" | "planned";

export interface EnvVarDefinition {
  readonly name: string;
  readonly group: EnvGroup;
  readonly type: EnvValueType;
  readonly status: EnvStatus;
  readonly description: string;
  readonly defaultValue?: string;
  readonly example?: string;
  readonly values?: readonly string[];
  readonly secret?: boolean;
}
