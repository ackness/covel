/**
 * Unified validation utilities for plugin and world manifests.
 *
 * Provides a single entry point for validating PLUGIN.md frontmatter
 * and world.yaml files with structured error reporting.
 */

import type { ZodError, ZodType } from "zod";
import { runtimeManifestSchema } from "./plugin.js";
import {
	worldManifestSchema,
	worldDimensionsSchema,
	DIMENSION_KEY_SCHEMAS,
} from "./world.js";

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
	return validate(runtimeManifestSchema, data);
}

/**
 * Validate a world.yaml manifest object.
 */
export function validateWorldManifest(data: unknown): ManifestValidationResult {
	return validate(worldManifestSchema, data);
}

/**
 * Validate a single dimension data object (e.g., geography, factions) against its sub-schema.
 */
export function validateDimensionData(
	key: string,
	data: unknown,
): ManifestValidationResult {
	const schema = DIMENSION_KEY_SCHEMAS[key];
	if (!schema) {
		return {
			valid: false,
			errors: [
				{
					path: "(root)",
					message: `Unknown dimension key: ${key}`,
					code: "custom",
				},
			],
		};
	}
	return validate(schema, data);
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
