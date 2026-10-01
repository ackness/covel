/**
 * Unified validation utilities for plugin and world manifests.
 *
 * Provides a single entry point for validating PLUGIN.md frontmatter
 * and world.yaml files with structured error reporting.
 */

import type { ZodError, ZodType } from "zod";
import { runtimeManifestInputSchema } from "./plugin.js";
import { worldManifestSchema, worldDimensionsSchema } from "./world.js";
import {
  dimensionIdSchema,
  worldDimensionDefinitionSchema,
} from "./dimensions.js";

// ── Validation result ───────────────────────────────────────────

export interface ManifestValidationResult<T = unknown> {
  readonly valid: boolean;
  readonly data?: T;
  readonly errors?: readonly ManifestValidationError[];
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
  filePath?: string,
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
 * Validate a PLUGIN.md frontmatter object.
 */
export function validatePluginManifest(
  data: unknown,
): ManifestValidationResult {
  return validate(runtimeManifestInputSchema, data);
}

/**
 * Validate a world.yaml manifest object.
 */
export function validateWorldManifest(data: unknown): ManifestValidationResult {
  return validate(worldManifestSchema, data);
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
