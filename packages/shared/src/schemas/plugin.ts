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

// ── Author's note / Post-history declarations (S3-T4) ──────────

/**
 * Segment 9 — Author's note. Inserted near the end of the message history,
 * just before the Nth-from-last message (default depth = 4). Content is
 * interpolated with the same variable map as the plugin body.
 */
export const authorsNoteDeclSchema = z
  .object({
    content: z.string().min(1),
    depth: z.number().int().optional(),
    role: z.enum(['system', 'user', 'assistant']).optional(),
  })
  .strict();

/**
 * Segment 10 — Post-history instructions. Appended at the very end of the
 * message array as a high-weight re-anchoring message.
 */
export const postHistoryDeclSchema = z
  .object({
    content: z.string().min(1),
    role: z.enum(['system', 'user']).optional(),
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
    /**
     * Prompt assembler version (S2-T4).
     * - `1` (default, omitted): legacy single-pass `buildContext` path
     * - `2`: three-tier V2 assembler (gated on `COVEL_PROMPT_V2=1` at runtime)
     *
     * V2 is opt-in per-plugin. The runtime only routes a manifest to V2 when
     * BOTH the environment flag and this field declare opt-in.
     */
    promptVersion: z.union([z.literal(1), z.literal(2)]).optional(),
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
    summaryFocus: z.array(z.string()).optional(),
    authorsNote: authorsNoteDeclSchema.optional(),
    postHistory: postHistoryDeclSchema.optional(),
  })
  .strict();

export type RuntimeManifestInput = z.input<typeof runtimeManifestSchema>;
