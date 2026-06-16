/**
 * Zod schemas and types for validating PLUGIN.md frontmatter.
 *
 * These schemas are used by @covel/plugin-loader to validate parsed YAML.
 *
 * This module is the stable aggregation point: the Zod definitions live in
 * `plugin-schemas.ts` and the derived types / semantic checks in
 * `plugin-types.ts`. Re-exporting both here keeps the public surface unchanged.
 */

export * from "./plugin-schemas.js";
export * from "./plugin-types.js";
