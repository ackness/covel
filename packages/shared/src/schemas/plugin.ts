/**
 * Zod schemas for validating PLUGIN.md frontmatter.
 *
 * These schemas are used by @covel/plugin-loader to validate parsed YAML.
 */

import { z } from 'zod';

// ── Trigger ──────────────────────────────────────────────────────

export const triggerTypeSchema = z.enum([
  'auto',
  'manual',
  'scheduled',
  'conditional',
  'event',
  'error-retry',
]);

export const triggerConfigSchema = z
  .object({
    type: triggerTypeSchema,
    interval: z.number().int().positive().optional(),
    condition: z.string().optional(),
    topic: z.string().optional(),
    maxTriggerCount: z.number().int().positive().optional(),
    maxRetryCount: z.number().int().nonnegative().optional(),
    cooldownTurns: z.number().int().nonnegative().optional(),
    phases: z.array(z.string()).optional(),
  })
  .strict();

// ── Input ────────────────────────────────────────────────────────

export const inputInjectDeclSchema = z
  .object({
    from: z.string().min(1),
    field: z.string().min(1),
    as: z.string().min(1),
  })
  .strict();

export const inputToolDeclSchema = z
  .object({
    plugin: z.string().min(1),
    runtime: z.string().min(1),
  })
  .strict();

export const inputConfigSchema = z
  .object({
    inject: z.array(inputInjectDeclSchema).optional(),
    tools: z.array(inputToolDeclSchema).optional(),
  })
  .strict();

// ── Output ───────────────────────────────────────────────────────

export const outputKindSchema = z.enum(['story', 'plugin', 'system']);

export const outputConfigSchema = z
  .object({
    schema: z.string().optional(),
    recordAs: z.string().optional(),
  })
  .strict();

// ── Tools ────────────────────────────────────────────────────────

export const toolsConfigSchema = z
  .object({
    builtin: z.array(z.string()).optional(),
    local: z.array(z.string()).optional(),
  })
  .strict();

// ── Config field ─────────────────────────────────────────────────

export const configFieldTypeSchema = z.enum([
  'string',
  'integer',
  'number',
  'boolean',
  'enum',
]);

export const pluginConfigFieldSchema = z
  .object({
    type: configFieldTypeSchema,
    default: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z.array(z.string()).optional(),
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

// ── Hook declarations ────────────────────────────────────────────

const VALID_HOOK_EVENTS = [
  'TurnStart',
  'PreRuntime',
  'PostRuntime',
  'PreToolUse',
  'PostToolUse',
  'PreStateCommit',
  'PostStateCommit',
  'TurnStop',
] as const;

export const hookDeclarationSchema = z
  .object({
    event: z.enum(VALID_HOOK_EVENTS),
    handler: z.string().min(1),
    match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

// ── UI spec ─────────────────────────────────────────────────────

export const uiSpecSchema = z
  .object({
    right: z.array(z.string().min(1)).optional(),
    message: z.array(z.string().min(1)).optional(),
    left: z.array(z.string().min(1)).optional(),
  })
  .strict();

// ── Runtime manifest ─────────────────────────────────────────────

export const runtimeManifestSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/, {
      message: 'name must be lowercase with hyphens, optional slash separators (e.g. "my-runtime" or "my-plugin/sub-runtime")',
    }),
    description: z.string().min(1),
    priority: z.number().int().min(0).max(1000),
    version: z.string().optional(),
    runtimeType: z.enum(['agent', 'function']).optional(),
    handler: z.string().optional(),
    guard: z.string().optional(),
    model: z.string().optional(),
    pluginType: z.enum(['core-plugin', 'plugin']).optional(),
    outputKind: outputKindSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    trigger: triggerConfigSchema.optional(),
    tools: toolsConfigSchema.optional(),
    input: inputConfigSchema.optional(),
    output: outputConfigSchema.optional(),
    config: z.record(z.string(), pluginConfigFieldSchema).optional(),
    i18n: z.record(z.string(), z.string()).optional(),
    ui: uiSpecSchema.optional(),
    hooks: z.array(hookDeclarationSchema).optional(),
  })
  .strict();

export type RuntimeManifestInput = z.input<typeof runtimeManifestSchema>;
