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
  worldPluginsSchema,
  pluginPitchSchema,
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
   * ones.
   */
  readonly ignoredFields?: readonly string[];
  /**
   * Problems of a section that tolerant loading left out because it does not
   * validate: the world loads without it.
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
 * Tolerant player loading omits unknown root fields and invalid optional
 * selection/presentation sections with diagnostics. Strict author validation
 * rejects them. The rest of the world remains usable.
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
  const manifest = { ...data };
  for (const [key, schema] of [
    ["plugins", worldPluginsSchema],
    ["pluginPitch", pluginPitchSchema],
  ] as const) {
    if (data[key] === undefined) continue;
    const section = schema.safeParse(data[key]);
    if (!section.success) {
      delete manifest[key];
      droppedSections.push(
        ...formatZodErrors(section.error).map((issue) => ({
          ...issue,
          path: issue.path === "(root)" ? key : `${key}.${issue.path}`,
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
