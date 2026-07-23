/**
 * Zod schemas for validating PLUGIN.md frontmatter.
 *
 * These schemas are used by @covel/plugin-loader to validate parsed YAML.
 */

import { z } from "zod";
import { HOOK_EVENTS } from "../types/hooks.js";
import type { EffectResource } from "../types/runtime-scheduling.js";

// ── Shared path & scheduling primitives ──────────────────────────
// Hoisted so the Input section (runtime-export inject, data bindings) and the
// scheduling sub-schemas below can all reuse them. `pluginRelativeJsonSchemaPath`
// also validates dataSchemas / output / event schema paths further down.

/**
 * A plugin-relative `.json` schema path. Blocks path traversal at the schema
 * level (no leading `/`, no `..` segments); the loader adds a defence-in-depth
 * containment check on the resolved absolute path.
 */
const pluginRelativeJsonSchemaPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.json$/i, {
    message:
      "schema must be a plugin-relative .json path (no leading `/`, no `..` segments)",
  });

/** capability cardinality — `one` (any single provider) or `all` (every provider). */
export const dependencyCardinalitySchema = z.enum(["one", "all"]);

/** `needs` gate scope — same-execution (`turn`) or persistent snapshot (`session`). */
export const dependencyScopeSchema = z.enum(["turn", "session"]);

/**
 * A dependency/binding source: exactly one of `runtime` (an id) or `capability`
 * (a tag, with optional `cardinality`). Both object shapes are `.strict()`, so
 * `{ runtime, capability }` — or a stray `cardinality` on a runtime ref — is
 * rejected: cardinality is capability-only by construction.
 */
export const bindingSourceSchema = z.union([
  z.object({ runtime: z.string().min(1) }).strict(),
  z
    .object({
      capability: z.string().min(1),
      cardinality: dependencyCardinalitySchema.optional(),
    })
    .strict(),
]);

/** Binding / export local name — letter-led identifier. */
const bindingNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
  message:
    "name must start with a letter and contain only letters/digits/underscore/hyphen",
});

/** RFC 6901 JSON Pointer (empty string = whole document). */
const jsonPointerSchema = z.string().regex(/^(\/([^/~]|~0|~1)*)*$/, {
  message:
    "must be an RFC 6901 JSON Pointer (empty string, or /-separated tokens with ~0/~1 escapes)",
});

/** Reject duplicate entries in set-like string arrays (effects, http methods). */
const hasUniqueItems = <T>(items: readonly T[]): boolean =>
  new Set(items).size === items.length;

// ── Trigger ──────────────────────────────────────────────────────

/**
 * Production trigger types — the reserved `conditional` / `error-retry` (which
 * never fire; no condition engine, the scheduler never surfaces upstream
 * failures) are now REJECTED at load, not just disabled downstream. A
 * third-party manifest declaring one was already non-functional (its runtime
 * never triggered); failing the load surfaces that instead of silently dropping.
 */
export const triggerTypeSchema = z.enum([
  "auto",
  "manual",
  "scheduled",
  "event",
]);

/** Trigger fields shared by the compat and authoring trigger schemas. */
const triggerConfigShape = {
  interval: z.number().int().positive().optional(),
  condition: z.string().optional(),
  topic: z.string().optional(),
  maxTriggerCount: z.number().int().positive().optional(),
  maxRetryCount: z.number().int().nonnegative().optional(),
  cooldownTurns: z.number().int().nonnegative().optional(),
  startTurn: z.number().int().positive().optional(),
};

export const triggerConfigSchema = z
  .object({ type: triggerTypeSchema, ...triggerConfigShape })
  .strict();

/**
 * Authoring schema — identical to the compat schema now that reserved triggers
 * are rejected on both. Kept as distinct exports so the authoring / compat call
 * sites stay explicit (and can diverge again if the authoring surface tightens
 * further, e.g. dropping `priority` / `upstreamRequired`).
 */
export const authoringTriggerTypeSchema = triggerTypeSchema;

export const authoringTriggerConfigSchema = triggerConfigSchema;

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
 * Runtime-export inject — consume a producer runtime's persisted `recordAs`
 * export (the latest revision committed before this execution started). `from`
 * selects the producer by runtime id or capability; `recordAs` names the
 * export key. Cross-execution counterpart to the same-execution `inputs`
 * bindings.
 */
export const runtimeExportInjectDeclSchema = z
  .object({
    kind: z.literal("runtime-export"),
    name: bindingNameSchema,
    from: bindingSourceSchema,
    recordAs: z.string().min(1),
    accepts: pluginRelativeJsonSchemaPath.optional(),
    required: z.boolean().optional(),
  })
  .strict();

/**
 * Discriminated union of inject declarations. Every entry declares its source
 * with `kind` so manifest semantics stay explicit.
 */
export const inputInjectDeclSchema = z.discriminatedUnion("kind", [
  runtimeInjectDeclSchema,
  pluginDataInjectDeclSchema,
  runtimeExportInjectDeclSchema,
]);

export const inputToolDeclSchema = z
  .object({
    plugin: z.string().min(1),
    runtime: z.string().min(1),
  })
  .strict();

export const inputConfigSchema = z
  .object({
    /** Runtime-dir-relative JSON Schema path validating the activation payload. */
    schema: pluginRelativeJsonSchemaPath.optional(),
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
    /** Names of entry-registered plugin tools this runtime exposes to its LLM. */
    plugin: z.array(z.string()).optional(),
    /**
     * Deferred tool loading (tool-search). `true` defers the runtime's entire
     * whitelist; a string array defers just those names. Mirrors
     * `ToolsConfig.defer` in types/plugin.ts.
     */
    defer: z.union([z.literal(true), z.array(z.string())]).optional(),
  })
  .strict();

// ── Hook declarations ────────────────────────────────────────────

// Validation set derived from the single source of truth (./types/hooks.ts),
// never re-listed by hand — adding an event there extends this schema for free.
export const hookDeclarationSchema = z
  .object({
    event: z.enum(HOOK_EVENTS),
    handler: z.string().min(1),
    match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    timeoutMs: z.number().int().positive().optional(),
    enforce: z.enum(["pre", "normal", "post"]).optional(),
  })
  .strict();

// ── Author's note / Post-history declarations ──────────

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

// ── Plugin RPC declarations ───────────────────────────────

/**
 * RPC action declaration for `RuntimeManifest.rpc[actionName]`. Validates
 * the per-action shape declared in PLUGIN.md frontmatter.
 *
 * `handler` and `input` are constrained to plugin-relative paths to block
 * path-traversal at the schema level:
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

// ── Event declarations ──────────────────────────────────────────

const EVENT_TOPIC_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Declares a domain event a plugin's runtime may emit via the builtin
 * `emit-event` tool. The event directory service (apps/server) aggregates
 * these across active plugins per session and validates emitted payloads
 * against `schema` before they enter the same-turn event fan-out.
 */
export const pluginEventDeclSchema = z
  .object({
    topic: z
      .string()
      .regex(
        EVENT_TOPIC_RE,
        "event topic must be dot-separated kebab-case (domain.verb)",
      ),
    schema: pluginRelativeJsonSchemaPath,
    description: i18nTextLoose,
    /** When true (default) the contract is advertised to emitting runtimes. */
    advertise: z.boolean().default(true),
  })
  .strict();

// ── Core-memory block schema ────────────────────────────────────

/**
 * Declarative core-memory block definition for `RuntimeManifest.memoryBlocks`.
 * Validates the per-block shape declared in PLUGIN.md frontmatter so the
 * memory system can drive extraction/rendering off plugin data instead of
 * hardcoded block labels. See {@link MemoryBlockSchema}.
 */
export const memoryBlockDeclSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, {
        message:
          "memory block label must be lowercase snake_case (letters, digits, underscores)",
      }),
    displayName: i18nTextLoose,
    extractionHint: i18nTextLoose,
    icon: z.string().min(1).optional(),
    maxChars: z.number().int().positive().optional(),
  })
  .strict();

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
    type: z.enum([
      "text",
      "textarea",
      "number",
      "integer",
      "toggle",
      "select",
      "slider",
    ]),
    // zod 4.4: a bare `z.unknown()` field in ANY object (strict or not) is now
    // treated as a required key (4.3 treated it as optional); `.optional()`
    // keeps the field omittable so plugins can declare a setting with no default.
    default: z.unknown().optional(),
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

// ── Scheduling: stage / dependencies / bindings ──────────────────

/** Coarse scheduling stage (replaces numeric priority bands). */
export const stageSchema = z.enum([
  "setup",
  "pre-turn",
  "narrative",
  "post-turn",
  "audit",
]);

/**
 * `after` entry — weak ordering, no gate. A bare string is shorthand for
 * `{ runtime }`; the object form is a {@link bindingSourceSchema} (runtime XOR
 * capability). `scope` is intentionally NOT accepted on `after` entries.
 */
export const afterRefSchema = z.union([z.string().min(1), bindingSourceSchema]);

/**
 * `needs` entry — ordering + gate. Adds an optional `scope` (turn/session) to
 * either a runtime or capability ref; `cardinality` stays capability-only.
 */
export const needsRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      runtime: z.string().min(1),
      scope: dependencyScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      capability: z.string().min(1),
      cardinality: dependencyCardinalitySchema.optional(),
      scope: dependencyScopeSchema.optional(),
    })
    .strict(),
]);

/** Typed same-execution data binding (`inputs.<name>`). */
export const runtimeBindingSchema = z
  .object({
    from: bindingSourceSchema,
    select: jsonPointerSchema.optional(),
    required: z.boolean().optional(),
    accepts: pluginRelativeJsonSchemaPath.optional(),
  })
  .strict();

export const inputsBindingMapSchema = z.record(
  bindingNameSchema,
  runtimeBindingSchema,
);

// ── Result format ────────────────────────────────────────────────

export const resultFormatSchema = z.enum(["legacy", "envelope-v1"]);

// ── Effects declaration ──────────────────────────────────────────

/**
 * Namespaced resource key for read/write-set hazard detection. Fixed builtin
 * namespaces, or a scoped `plugin-data:self:<ns>` / `event:<topic>` /
 * `http:https://<host>` key.
 */
// The templated members (`plugin-data:self:` / `event:` / `http:`) are regex
// strings so the pattern survives into the generated JSON Schema, but Zod infers
// them as `string`. Narrow the static type to `EffectResource` to match the
// manifest interface — runtime validation and JSON Schema output are unchanged.
export const effectResourceSchema = z.union([
  z.enum([
    "state:*",
    "narrative:*",
    "characters:*",
    "assets:*",
    "media:*",
    "working-memory:*",
    "lorebook:*",
    "ui:*",
    "interaction:*",
    "unknown:*",
  ]),
  z.string().regex(/^plugin-data:self:[a-zA-Z][a-zA-Z0-9_-]*$/, {
    message: "plugin-data effect must be `plugin-data:self:<namespace>`",
  }),
  z.string().regex(/^event:[^\s]+$/, {
    message: "event effect must be `event:<topic>`",
  }),
  z.string().regex(/^http:https:\/\/[^/?#@]+$/, {
    message: "http effect must be `http:https://<host>`",
  }),
]) as unknown as z.ZodType<EffectResource>;

export const effectsDeclSchema = z
  .object({
    // Uniqueness is enforced here but is NOT representable in JSON Schema via
    // z.toJSONSchema (the refine is dropped) — the generated schemas note it.
    reads: z
      .array(effectResourceSchema)
      .refine(hasUniqueItems, "reads entries must be unique")
      .optional(),
    writes: z
      .array(effectResourceSchema)
      .refine(hasUniqueItems, "writes entries must be unique")
      .optional(),
    parallelSafe: z.boolean().optional(),
  })
  .strict();

// ── HTTP permission declaration ──────────────────────────────────

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);

export const httpPermissionDeclSchema = z
  .object({
    origin: z.string().regex(/^https:\/\/[^/?#@]+$/, {
      message:
        "origin must be a canonical https origin (no path, query, or credentials)",
    }),
    methods: z
      .array(httpMethodSchema)
      .min(1)
      .refine(hasUniqueItems, "methods must be unique")
      .optional(),
  })
  .strict();

export const permissionsDeclSchema = z
  .object({ http: z.array(httpPermissionDeclSchema).optional() })
  .strict();

// ── Legacy job-status view projection (compat only) ──────────────

export const legacyJobViewDeclSchema = z
  .object({
    jobIdPrefix: z.string().optional(),
    namespace: z.string().min(1),
    keyFrom: jsonPointerSchema.optional(),
    valueFrom: jsonPointerSchema.optional(),
  })
  .strict();

export const jobStatusDeclSchema = z
  .object({ legacyViews: z.array(legacyJobViewDeclSchema).optional() })
  .strict();

// ── Cross-field constraints ──────────────────────────────────────

/**
 * Structural view of the manifest fields the cross-field checks read. Kept
 * loose so both the compat (priority present) and authoring parsed shapes are
 * accepted; the checks work off plain data and return issues, so neither
 * superRefine has to name Zod's refinement-ctx type.
 */
interface ManifestCrossFieldView {
  readonly stage?: string;
  readonly trigger?: {
    readonly type?: string;
    readonly topic?: string;
    readonly interval?: number;
    readonly startTurn?: number;
    readonly cooldownTurns?: number;
  };
  readonly output?: { readonly schema?: string; readonly recordAs?: string };
}

interface CrossFieldIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Cross-field constraints applied by BOTH manifest schemas. Every constraint
 * here was grepped against the bundled plugins and has zero current violations,
 * so it is safe on the compat superset. JSON Schema cannot express these, so
 * the generated schemas record them in their `description`.
 */
function sharedManifestCrossFieldIssues(
  m: ManifestCrossFieldView,
): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];

  // recordAs is only meaningful with a schema validating the recorded value.
  if (m.output?.recordAs !== undefined && m.output.schema === undefined) {
    issues.push({
      path: ["output", "schema"],
      message: "output.schema is required when output.recordAs is declared",
    });
  }

  // An event trigger without a topic never subscribes to anything.
  if (m.trigger?.type === "event" && !m.trigger.topic) {
    issues.push({
      path: ["trigger", "topic"],
      message: "trigger.topic is required for trigger.type 'event'",
    });
  }

  // A stage places a runtime in the per-turn DAG; event/manual are detached.
  if (
    m.stage !== undefined &&
    (m.trigger?.type === "event" || m.trigger?.type === "manual")
  ) {
    issues.push({
      path: ["stage"],
      message: "a staged runtime cannot use trigger.type 'event' or 'manual'",
    });
  }

  // Setup runs before the turn loop: fixed auto trigger, no cadence fields.
  if (m.stage === "setup" && m.trigger) {
    if (m.trigger.type !== "auto") {
      issues.push({
        path: ["trigger", "type"],
        message: "stage 'setup' runtimes must use trigger.type 'auto'",
      });
    }
    for (const field of ["interval", "startTurn", "cooldownTurns"] as const) {
      if (m.trigger[field] !== undefined) {
        issues.push({
          path: ["trigger", field],
          message: `stage 'setup' runtimes cannot set trigger.${field}`,
        });
      }
    }
  }

  return issues;
}

/** Authoring-only additions: every scheduler-driven runtime declares a stage. */
function authoringManifestCrossFieldIssues(
  m: ManifestCrossFieldView,
): CrossFieldIssue[] {
  const issues = sharedManifestCrossFieldIssues(m);
  if (
    (m.trigger?.type === "auto" || m.trigger?.type === "scheduled") &&
    m.stage === undefined
  ) {
    issues.push({
      path: ["stage"],
      message: "stage is required for auto / scheduled runtimes",
    });
  }
  return issues;
}

// ── Runtime manifest ─────────────────────────────────────────────

/**
 * Field definitions shared by the compat (`runtimeManifestInputSchema`) and
 * strict authoring (`runtimeManifestAuthoringSchema`) manifest schemas. The
 * legacy-only fields (`priority`, `upstreamRequired`, `jobStatus`) and the
 * schema-specific `trigger` are added per schema below, so the two never drift.
 */
const runtimeManifestCommonShape = {
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/, {
      message:
        'name must be lowercase with hyphens, optional slash separators (e.g. "my-runtime" or "my-plugin/sub-runtime")',
    }),
  description: z.string().min(1),
  // Friendly, player-facing name (I18nText). Distinct from `name`, which is
  // the runtime id. Surfaced via PluginSummary.displayName for plugin lists.
  displayName: i18nTextLoose.optional(),
  version: z.string().optional(),
  runtimeType: z.enum(["agent", "function"]).optional(),
  handler: z.string().optional(),
  guard: z.string().optional(),
  /**
   * Plugin-root-relative path to a media-wires module (image / speech /
   * transcription vendor wires). Declare on ONE runtime per plugin.
   * Constrained like rpc handlers to block path traversal at schema level.
   */
  wires: pluginRelativeJsPath.optional(),
  /**
   * Plugin-root-relative path to a unified server entry module
   * (`export default function (covel) { ... }`). Declare on ONE runtime
   * per plugin. Same traversal constraint as `wires` / rpc handlers.
   */
  entry: pluginRelativeJsPath.optional(),
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
  /** Retry a bare (no-tool-call) finish once before releasing. Default false. */
  requireToolUse: z.boolean().optional(),
  /** Maximum nested ctx.recursiveCall() depth. Default 10. */
  maxRecursionDepth: z.number().int().min(0).max(50).optional(),
  pluginType: z.enum(["core-plugin", "plugin"]).optional(),
  outputKind: outputKindSchema.optional(),
  /**
   * Capability tags for framework discovery. Free-form by design: plugins
   * may declare arbitrary custom tags. The framework only acts on the tags in
   * `FRAMEWORK_KNOWN_CAPABILITIES` (plugin-level `FrameworkCapability` +
   * runtime-level `FrameworkRuntimeCapability`); at server bootstrap,
   * `validateRuntimeManifestSemantics` warns when a declared tag looks like
   * a misspelled framework-known one.
   */
  capabilities: z.array(z.string().min(1)).optional(),
  tags: z.array(pluginTagSchema).optional(),
  relations: pluginRelationsSchema.optional(),
  /** Coarse scheduling stage (replaces numeric priority bands). */
  stage: stageSchema.optional(),
  /** Weak ordering dependencies (no gate). */
  after: z.array(afterRefSchema).optional(),
  /** Strong dependencies: ordering + gate (supersedes `upstreamRequired`). */
  needs: z.array(needsRefSchema).optional(),
  /** Typed same-execution data bindings, keyed by local binding name. */
  inputs: inputsBindingMapSchema.optional(),
  /** How the normalizer parses this runtime's handler return value. */
  resultFormat: resultFormatSchema.optional(),
  /** Handler may be replayed from a frozen activation boundary on resume. */
  suspensionSafe: z.boolean().optional(),
  /** Explicit read/write-set override for parallel hazard detection. */
  effects: effectsDeclSchema.optional(),
  /** Declared permission upper bounds (currently HTTP origins + methods). */
  permissions: permissionsDeclSchema.optional(),
  /**
   * Execution mode when activated via manual plugin-rpc (`sync` awaits,
   * `background` returns a jobId and streams progress via `_jobs`
   * plugin-data). Ignored for scheduler-driven runtimes.
   */
  execution: z.enum(["sync", "background"]).optional(),
  /**
   * When true, the session-level event directory (aggregated across all
   * active runtimes' `events` declarations) is rendered into this
   * runtime's segment 5 prompt so the LLM knows which topics it may emit
   * via the builtin `emit-event` tool.
   */
  advertiseEvents: z.boolean().optional(),
  tools: toolsConfigSchema.optional(),
  input: inputConfigSchema.optional(),
  output: outputConfigSchema.optional(),
  dataSchemas: pluginDataSchemaMapSchema.optional(),
  /** Domain events this plugin's runtime may emit via `emit-event`. */
  events: z.array(pluginEventDeclSchema).optional(),
  i18n: z.record(z.string(), z.string()).optional(),
  ui: uiSpecSchema.optional(),
  userSettings: z.array(pluginUserSettingSpecSchema).optional(),
  hooks: z.array(hookDeclarationSchema).optional(),
  summaryFocus: z.array(z.string()).optional(),
  authorsNote: authorsNoteDeclSchema.optional(),
  postHistory: postHistoryDeclSchema.optional(),
  rpc: rpcDeclMapSchema.optional(),
  memoryBlocks: z.array(memoryBlockDeclSchema).optional(),
} as const;

/**
 * Compat input schema — a pure SUPERSET of the historical manifest schema:
 * every currently-shipping PLUGIN.md still parses. Keeps the legacy fields
 * (`priority` / `upstreamRequired` / `jobStatus`) and the full trigger enum
 * (including the reserved `conditional` / `error-retry`). The cross-field
 * checks it adds all have zero current violations (grepped against the bundled
 * plugins), so they never reject a shipping manifest.
 */
export const runtimeManifestInputSchema = z
  .object({
    ...runtimeManifestCommonShape,
    /** Legacy numeric priority band. Superseded by `stage` + `after`/`needs`. */
    priority: z.number().int().min(0).max(1000).optional(),
    /** Legacy strong-dependency alias. Superseded by `needs`. */
    upstreamRequired: z
      .array(
        z.union([
          z.string().min(1),
          z.object({ capability: z.string().min(1) }).strict(),
        ]),
      )
      .optional(),
    trigger: triggerConfigSchema.optional(),
    /** Compat-period projection of kernel job-status into legacy plugin-data views. */
    jobStatus: jobStatusDeclSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const issue of sharedManifestCrossFieldIssues(m)) {
      ctx.addIssue({
        code: "custom",
        path: [...issue.path],
        message: issue.message,
      });
    }
  });

/**
 * Compat alias. The plugin loader and `validate.ts` import this name; it is the
 * exact same schema object as {@link runtimeManifestInputSchema}, so the loader
 * needs no change.
 */
export const runtimeManifestSchema = runtimeManifestInputSchema;

/**
 * Strict authoring target — the shape new plugins should be written against.
 * Shares {@link runtimeManifestCommonShape}, but: the trigger enum drops the
 * reserved types; `priority` / `upstreamRequired` / `jobStatus` are rejected
 * (omitted under `.strict()`); and every cross-field constraint is enforced,
 * including "auto / scheduled runtimes must declare a stage". Background
 * `execution` stays legal (it is a live mechanism, not a legacy field).
 */
export const runtimeManifestAuthoringSchema = z
  .object({
    ...runtimeManifestCommonShape,
    trigger: authoringTriggerConfigSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const issue of authoringManifestCrossFieldIssues(m)) {
      ctx.addIssue({
        code: "custom",
        path: [...issue.path],
        message: issue.message,
      });
    }
  });
