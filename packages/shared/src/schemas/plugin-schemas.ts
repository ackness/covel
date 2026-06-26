/**
 * Zod schemas for validating PLUGIN.md frontmatter.
 *
 * These schemas are used by @covel/plugin-loader to validate parsed YAML.
 */

import { z } from "zod";

// ── Trigger ──────────────────────────────────────────────────────

export const triggerTypeSchema = z.enum([
  "auto",
  "manual",
  "scheduled",
  "conditional",
  "event",
  "error-retry",
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
    startTurn: z.number().int().positive().optional(),
  })
  .strict();

// ── Input ────────────────────────────────────────────────────────

/**
 * Runtime-output inject — read a field from a completed upstream runtime's
 * output and wrap it in an XML tag.
 */
export const runtimeInjectDeclSchema = z
  .object({
    kind: z.literal("runtime"),
    from: z.string().min(1),
    field: z.string().min(1),
    as: z.string().min(1),
  })
  .strict();

/**
 * Plugin-data inject — read the runtime's OWN plugin-data namespace
 * (cross-plugin reads are intentionally not supported) and inline a
 * summarised view into the prompt. Used by increment-maintaining plugins
 * (codex, char tracker, graph extractor) so the LLM sees existing state
 * deterministically without needing a tool-call round-trip.
 *
 * `format`:
 *  - `summary` (default): `- {key} | {updatedAt} | {json-truncated-200}`
 *  - `ids-only`: `- {key}`
 *  - `full`: `- {key}: {full-json}`
 *
 * `maxEntries` bounds token cost. When the namespace has more rows than
 * the cap, a deterministic two-pass truncation is applied: half the quota
 * goes to the oldest entries (createdAt ascending, stable "anchor" view)
 * and the other half to the most recently updated entries. Entries appear
 * in each slot at most once.
 */
export const pluginDataInjectDeclSchema = z
  .object({
    kind: z.literal("plugin-data"),
    namespace: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/i, {
        message:
          "namespace must be a short identifier (letters, digits, underscore, hyphen)",
      }),
    as: z.string().min(1),
    format: z
      .enum(["summary", "full", "ids-only"])
      .optional()
      .default("summary"),
    maxEntries: z.number().int().min(1).max(500).optional().default(50),
  })
  .strict();

/**
 * Discriminated union of inject declarations. Every entry declares its source
 * with `kind` so manifest semantics stay explicit.
 */
export const inputInjectDeclSchema = z.discriminatedUnion("kind", [
  runtimeInjectDeclSchema,
  pluginDataInjectDeclSchema,
]);

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

export const outputKindSchema = z.enum(["story", "plugin", "system"]);

export const outputConfigSchema = z
  .object({
    schema: z.string().optional(),
    recordAs: z.string().optional(),
  })
  .strict();

// ── Plugin data schemas ─────────────────────────────────────────

const pluginDataNamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/i, {
    message:
      "namespace must be a short identifier (letters, digits, underscore, hyphen)",
  });

const pluginRelativeJsonSchemaPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.json$/i, {
    message:
      "schema must be a plugin-relative .json path (no leading `/`, no `..` segments)",
  });

export const pluginDataSchemaDeclSchema = z
  .object({
    namespace: pluginDataNamespaceSchema.optional(),
    schemaVersion: z.number().int().positive(),
    acceptsWorldData: z.boolean(),
    schema: pluginRelativeJsonSchemaPath,
    description: z.string().optional(),
  })
  .strict();

export const pluginDataSchemaMapSchema = z
  .record(pluginDataNamespaceSchema, pluginDataSchemaDeclSchema)
  .transform((schemas) =>
    Object.fromEntries(
      Object.entries(schemas).map(([namespace, decl]) => [
        namespace,
        { ...decl, namespace: decl.namespace ?? namespace },
      ]),
    ),
  )
  .superRefine((schemas, ctx) => {
    for (const [namespace, decl] of Object.entries(schemas)) {
      if (decl.namespace !== namespace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [namespace, "namespace"],
          message: `namespace must match dataSchemas key "${namespace}"`,
        });
      }
    }
  });

// ── Tools ────────────────────────────────────────────────────────

export const toolsConfigSchema = z
  .object({
    builtin: z.array(z.string()).optional(),
    local: z.array(z.string()).optional(),
  })
  .strict();

// ── Config field ─────────────────────────────────────────────────

export const configFieldTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
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
  "SessionStart",
  "SessionEnd",
  "TurnStart",
  "PreCompaction",
  "PostCompaction",
  "PreSchedule",
  "PreRuntime",
  "PostContextAssembly",
  "PreLLMCall",
  "PostLLMResponse",
  "PostRuntime",
  "PreToolUse",
  "PostToolUse",
  "PreStateCommit",
  "PostStateCommit",
  "TurnStop",
] as const;

export const hookDeclarationSchema = z
  .object({
    event: z.enum(VALID_HOOK_EVENTS),
    handler: z.string().min(1),
    match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    timeoutMs: z.number().int().positive().optional(),
    enforce: z.enum(["pre", "normal", "post"]).optional(),
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
    role: z.enum(["system", "user", "assistant"]).optional(),
  })
  .strict();

/**
 * Segment 10 — Post-history instructions. Appended at the very end of the
 * message array as a high-weight re-anchoring message.
 */
export const postHistoryDeclSchema = z
  .object({
    content: z.string().min(1),
    role: z.enum(["system", "user"]).optional(),
  })
  .strict();

// ── PR-3 Plugin RPC declarations ───────────────────────────────

/**
 * RPC action declaration for `RuntimeManifest.rpc[actionName]`. Validates
 * the per-action shape declared in PLUGIN.md frontmatter.
 *
 * `handler` and `input` are constrained to plugin-relative paths to block
 * path-traversal at the schema level (HIGH-1 fix from the code review):
 *
 *   - Must NOT start with `/` (absolute paths reset `path.resolve` base).
 *   - Must NOT contain `..` segments (would escape the plugin root).
 *   - Must end with `.js`, `.mjs`, or `.cjs` (handler) /
 *     `.json`, `.yaml`, `.yml` (input schema).
 *
 * The runtime loader applies a defence-in-depth check that the resolved
 * absolute path stays inside the plugin's discovery root — see
 * `apps/server/src/routes/api/bootstrap.ts` `loadHandler`.
 */
const pluginRelativeJsPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\/\.\.\/)(?!\.\.\/)[a-z0-9_./-]+\.[mc]?js$/i, {
    message:
      "handler must be a plugin-relative .js/.mjs/.cjs path (no leading `/`, no `..` segments)",
  });

const pluginRelativeSchemaPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\/\.\.\/)(?!\.\.\/)[a-z0-9_./-]+\.(json|ya?ml)$/i, {
    message:
      "input schema must be a plugin-relative .json/.yaml path (no leading `/`, no `..` segments)",
  });

export const rpcActionDeclSchema = z
  .object({
    handler: pluginRelativeJsPath,
    input: pluginRelativeSchemaPath.optional(),
    trustLevel: z.enum(["builtin", "official", "community"]).optional(),
    streaming: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

/**
 * Map of action name → declaration. Action names must be kebab-case and
 * may not start with `framework-` (reserved for framework default handlers).
 */
export const rpcDeclMapSchema = z.record(
  z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message:
        "rpc action name must be kebab-case (lowercase letters, digits, hyphens)",
    })
    .refine((name) => !name.startsWith("framework-"), {
      message: 'rpc action names starting with "framework-" are reserved',
    }),
  rpcActionDeclSchema,
);

const i18nTextLoose = z.union([z.string(), z.record(z.string(), z.string())]);

// ── Plugin catalogue metadata ───────────────────────────────────

const pluginTagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/i, {
    message:
      'tags must be identifiers such as "mode:dialogue", "role:narrator", or "ui-only"',
  });

const relationTargetSchema = z
  .union([
    z.string().min(1),
    z
      .object({
        plugin: z.string().min(1).optional(),
        runtime: z.string().min(1).optional(),
        capability: z.string().min(1).optional(),
        tag: pluginTagSchema.optional(),
      })
      .strict(),
  ])
  .optional();

const pluginRelationSchema = z
  .object({
    type: z
      .enum(["requires", "recommends", "conflicts", "provides"])
      .optional(),
    target: relationTargetSchema,
    plugin: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    capability: z.string().min(1).optional(),
    tag: pluginTagSchema.optional(),
    optional: z.boolean().optional(),
    reason: i18nTextLoose.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.target !== undefined ||
      value.plugin !== undefined ||
      value.runtime !== undefined ||
      value.capability !== undefined ||
      value.tag !== undefined,
    {
      message:
        "relation must declare target, plugin, runtime, capability, or tag",
    },
  );

export const pluginRelationsSchema = z
  .object({
    provides: z
      .array(z.union([z.string().min(1), pluginRelationSchema]))
      .optional(),
    requires: z
      .array(z.union([z.string().min(1), pluginRelationSchema]))
      .optional(),
    recommends: z
      .array(z.union([z.string().min(1), pluginRelationSchema]))
      .optional(),
    conflicts: z
      .array(z.union([z.string().min(1), pluginRelationSchema]))
      .optional(),
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

// ── User-declared plugin settings ────────────────────────────────

export const pluginUserSettingSpecSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
        message:
          "key must start with a letter and contain only letters/digits/underscore/hyphen",
      }),
    type: z.enum(["text", "number", "toggle", "select", "textarea"]),
    default: z.unknown(),
    label: i18nTextLoose,
    description: i18nTextLoose.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    options: z
      .array(
        z.object({
          value: z.string(),
          label: i18nTextLoose,
        }),
      )
      .optional(),
  })
  .strict();

// ── Runtime manifest ─────────────────────────────────────────────

export const runtimeManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/, {
        message:
          'name must be lowercase with hyphens, optional slash separators (e.g. "my-runtime" or "my-plugin/sub-runtime")',
      }),
    description: z.string().min(1),
    priority: z.number().int().min(0).max(1000).optional(),
    version: z.string().optional(),
    runtimeType: z.enum(["agent", "function"]).optional(),
    handler: z.string().optional(),
    guard: z.string().optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /**
     * Per-runtime cap on the agent tool-call loop. Overrides the framework
     * default (10). Lower values prevent runaway LLMs that keep calling the
     * same tool indefinitely after a successful result. Set to 1 or 2 for
     * single-shot plugins that should call one tool and stop.
     */
    maxSteps: z.number().int().positive().optional(),
    /** Smart retry count on transient LLM failures. Default 1. Set 0 to disable. */
    maxRetries: z.number().int().min(0).max(5).optional(),
    /** Per-LLM-call total timeout (ms). Caps a single provider call. */
    callTimeoutMs: z.number().int().positive().optional(),
    /** Streaming first-token (TTFB) timeout (ms). Default 30000. */
    firstTokenTimeoutMs: z.number().int().positive().optional(),
    /** Tool-call loop detection threshold. Default 3. Set 0 to disable. */
    loopDetectionThreshold: z.number().int().min(0).max(20).optional(),
    /** Maximum nested ctx.recursiveCall() depth. Default 10. */
    maxRecursionDepth: z.number().int().min(0).max(50).optional(),
    pluginType: z.enum(["core-plugin", "plugin"]).optional(),
    outputKind: outputKindSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    tags: z.array(pluginTagSchema).optional(),
    relations: pluginRelationsSchema.optional(),
    /**
     * Runtime IDs this runtime depends on for a successful upstream output.
     * When any listed upstream ran with `status !== 'success'` in the same
     * turn, the framework short-circuits this runtime and reports
     * `status: 'skipped'` before the guard / LLM pipeline. Use this for
     * plugins whose prompt is meaningless without fresh narrative context
     * (guide, codex, char-creator/character-tracker, npc-graph/extractor
     * all depend on narrator succeeding).
     */
    upstreamRequired: z.array(z.string().min(1)).optional(),
    trigger: triggerConfigSchema.optional(),
    /**
     * Execution mode when activated via manual plugin-rpc (`sync` awaits,
     * `background` returns a jobId and streams progress via `_jobs`
     * plugin-data). Ignored for scheduler-driven runtimes.
     */
    execution: z.enum(["sync", "background"]).optional(),
    tools: toolsConfigSchema.optional(),
    input: inputConfigSchema.optional(),
    output: outputConfigSchema.optional(),
    dataSchemas: pluginDataSchemaMapSchema.optional(),
    config: z.record(z.string(), pluginConfigFieldSchema).optional(),
    i18n: z.record(z.string(), z.string()).optional(),
    ui: uiSpecSchema.optional(),
    userSettings: z.array(pluginUserSettingSpecSchema).optional(),
    hooks: z.array(hookDeclarationSchema).optional(),
    summaryFocus: z.array(z.string()).optional(),
    authorsNote: authorsNoteDeclSchema.optional(),
    postHistory: postHistoryDeclSchema.optional(),
    rpc: rpcDeclMapSchema.optional(),
  })
  .strict();
