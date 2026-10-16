/**
 * Unified validation utilities for plugin and world manifests.
 *
 * Provides a single entry point for validating PLUGIN.md frontmatter
 * and world.yaml files with structured error reporting.
 */

import { isRecord } from "../utils/is-record.js";
import type { ZodError, ZodType } from "zod";
import { pluginManifestSchema } from "./plugin-manifest.js";
import {
  worldManifestSchema,
  worldDimensionsSchema,
  worldPluginPolicySchema,
} from "./world.js";
import {
  dimensionIdSchema,
  worldDimensionDefinitionSchema,
} from "@covel/plugin-handlers-utils/dimensions";

// ── Validation result ───────────────────────────────────────────

export interface ManifestValidationResult<T = unknown> {
  readonly valid: boolean;
  readonly data?: T;
  readonly errors?: readonly ManifestValidationError[];
  /**
   * Unknown fields left out by tolerant world-package loading: top-level
   * ones, and those inside `pluginPolicy` (`pluginPolicy.presetId`).
   */
  readonly ignoredFields?: readonly string[];
  /**
   * Problems of a section that tolerant loading left out because it does not
   * validate (`pluginPolicy`): the world loads without it.
   */
  readonly droppedSections?: readonly ManifestValidationError[];
}

export interface ManifestValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

// ── Internal helpers ────────────────────────────────────────────

function formatZodErrors(error: ZodError): ManifestValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

function validate<T>(
  schema: ZodType<T>,
  data: unknown,
): ManifestValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: formatZodErrors(result.error),
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Validate a PLUGIN.md frontmatter object against the package manifest
 * schema. Static file checks are `pnpm validate:plugin`'s job.
 */
export function validatePluginManifest(
  data: unknown,
): ManifestValidationResult {
  return validate(pluginManifestSchema, data);
}

/**
 * Validate a world.yaml manifest object.
 *
 * `ignoreUnknownRootFields` is how a world package is loaded: an unknown
 * top-level field, or an unknown field inside `pluginPolicy`, is left out
 * and listed in `ignoredFields`; a `pluginPolicy` that still does not
 * validate is left out and its problems listed in `droppedSections`. The
 * world then loads with the plugins every session has.
 */
export function validateWorldManifest(
  data: unknown,
  options?: { ignoreUnknownRootFields?: boolean },
): ManifestValidationResult {
  if (!options?.ignoreUnknownRootFields || !isRecord(data))
    return validate(worldManifestSchema, data);
  const ignoredFields = Object.keys(data).filter(
    (key) => !Object.hasOwn(worldManifestSchema.shape, key),
  );
  const droppedSections: ManifestValidationError[] = [];
  let manifest = data;
  if (data.pluginPolicy !== undefined) {
    const { pluginPolicy: written, ...rest } = data;
    const known = isRecord(written)
      ? Object.fromEntries(
          Object.entries(written).filter(([key]) => {
            if (Object.hasOwn(worldPluginPolicySchema.shape, key)) return true;
            ignoredFields.push(`pluginPolicy.${key}`);
            return false;
          }),
        )
      : written;
    const policy = worldPluginPolicySchema.safeParse(known);
    if (policy.success) manifest = { ...rest, pluginPolicy: known };
    else {
      manifest = rest;
      droppedSections.push(
        ...formatZodErrors(policy.error).map((issue) => ({
          ...issue,
          path:
            issue.path === "(root)"
              ? "pluginPolicy"
              : `pluginPolicy.${issue.path}`,
        })),
      );
    }
  }
  const result = validate(worldManifestSchema.strip(), manifest);
  return {
    ...result,
    ...(ignoredFields.length ? { ignoredFields } : {}),
    ...(droppedSections.length ? { droppedSections } : {}),
  };
}

/**
 * Validate an authored dimension ID and definition, independent of its subject.
 */
export function validateDimensionData(
  key: string,
  data: unknown,
): ManifestValidationResult {
  const id = dimensionIdSchema.safeParse(key);
  if (!id.success) {
    return {
      valid: false,
      errors: [
        {
          path: "(root)",
          message: `Invalid dimension ID: ${key}`,
          code: "custom",
        },
      ],
    };
  }
  return validate(worldDimensionDefinitionSchema, data);
}

/**
 * Validate a full dimensions object against worldDimensionsSchema.
 */
export function validateDimensions(data: unknown): ManifestValidationResult {
  return validate(worldDimensionsSchema, data);
}

/**
 * Format validation errors into a human-readable string.
 */
export function formatValidationErrors(
  errors: readonly ManifestValidationError[],
): string {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
}
