/**
 * Zod schemas for validating PLUGIN.md frontmatter.
 *
 * These schemas are used by @covel/plugin-loader to validate parsed YAML.
 */

import { DATA_OP_KINDS } from "@covel/plugin-handlers-utils";
import { z } from "zod";

/** A versioned extension point or UI slot name, such as `prompt.segment@1`. */
const extensionPointPattern = "[a-z][a-z0-9.-]*@[1-9][0-9]*";
/** The ID of an extension within its package. */
const extensionIdPattern = "[a-zA-Z0-9][\\w.-]*";

const extensionDeclarationSchema = z.strictObject({
  point: z
    .string()
    .regex(new RegExp(`^${extensionPointPattern}$`))
    .meta({
      description: "Extension point this entry provides.",
      examples: ["prompt.segment@1"],
    }),
  id: z
    .string()
    .regex(new RegExp(`^${extensionIdPattern}$`))
    .describe("ID of this extension within the package."),
  order: z
    .number()
    .int()
    .describe(
      "Sort order among providers of the same point. Lower values come first. Defaults to 0.",
    )
    .optional(),
  slot: z
    .string()
    .regex(new RegExp(`^${extensionPointPattern}$`))
    .describe("UI slot providers only: the kernel UI slot this entry fills.")
    .optional(),
  watch: z
    .array(z.string().min(1))
    .describe(
      "UI slot providers only: own data namespaces whose changes refresh the slot.",
    )
    .optional(),
  preview: z
    .array(z.string().min(1))
    .describe(
      "UI slot providers only: event topics whose in-turn preview refreshes the slot.",
    )
    .optional(),
});
import { HOOK_EVENTS } from "../types/hooks.js";
import { STAGE_ORDER } from "../types/runtime-scheduling.js";
import type { EffectResource } from "../types/runtime-scheduling.js";
import { slashCommandSpecSchema } from "./slash-command-schema.js";
import {
  IR_RULE_FIELD_PATHS,
  runtimeRuleIssues,
  type RuntimeRuleView,
} from "./runtime-rules.js";

// ── Shared path & scheduling primitives ──────────────────────────
// Hoisted so the Input section (runtime-export inject, data bindings) and the
// scheduling sub-schemas below can all reuse them. `pluginRelativeJsonSchemaPath`
// also validates dataSchemas / output / event schema paths further down.

/**
 * A plugin-relative `.json` schema path. Blocks path traversal at the schema
 * level (no leading `/`, no `..` segments); the loader adds a defence-in-depth
 * containment check on the resolved absolute path.
 */
export const pluginRelativeJsonSchemaPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.json$/i, {
    message:
      "schema must be a plugin-relative .json path (no leading `/`, no `..` segments)",
  });

/** Public framework schemas may be referenced by URI without plugin copies. */
const runtimeJsonSchemaReference = z.union([
  pluginRelativeJsonSchemaPath,
  z.string().regex(/^contract:[a-z][a-z0-9.-]*@[1-9][0-9]*$/),
]);

/** capability cardinality — `one` (any single provider) or `all` (every provider). */
const dependencyCardinalitySchema = z.enum(["one", "all"]);

/** `needs` gate scope — same-execution (`turn`) or persistent snapshot (`session`). */
const dependencyScopeSchema = z.enum(["turn", "session"]);

/**
 * A dependency/binding source: exactly one of `runtime` (an id) or `capability`
 * (a tag, with optional `cardinality`). Both object shapes are `.strict()`, so
 * `{ runtime, capability }` — or a stray `cardinality` on a runtime ref — is
 * rejected: cardinality is capability-only by construction.
 */
const bindingSourceSchema = z.union([
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
 * Trigger types. `auto` runs in its stage every turn, or every `every`-th
 * logical turn; `manual` and `event` are activated. Any other value is
 * rejected at load.
 */
export const triggerTypeSchema = z.enum(["auto", "manual", "event"]);

const everySchema = z
  .number()
  .int()
  .positive()
  .describe(
    "`auto` only: run on the logical turns that are a multiple of this number. Defaults to 1, every turn.",
  );

/** Trigger options an author writes under `schedule.trigger`. */
const triggerOptionsShape = {
  topic: z
    .string()
    .describe("Event topic to subscribe to. Required for `event`.")
    .optional(),
  maxTriggerCount: z
    .number()
    .int()
    .positive()
    .describe("Maximum number of triggers in one session.")
    .optional(),
  cooldownTurns: z
    .number()
    .int()
    .nonnegative()
    .describe("Minimum number of turns between two triggers.")
    .optional(),
  startTurn: z
    .number()
    .int()
    .positive()
    .describe(
      "First logical turn at which the runtime may trigger. When unset, it triggers as soon as its stage opens.",
    )
    .optional(),
};

/** The compiled trigger of a runtime (`RuntimeManifest.trigger`), as the API reports it. */
export const triggerConfigSchema = z
  .object({
    type: triggerTypeSchema.describe(
      "`auto` runs in its stage every turn, or every `every`-th turn. `manual` runs on an explicit RPC call. `event` runs when `topic` is emitted.",
    ),
    every: everySchema.optional(),
    ...triggerOptionsShape,
  })
  .strict();

/** `schedule.trigger` of RUNTIME.md: the type defaults to `auto`. */
export const authoringTriggerSchema = z
  .object({
    type: triggerTypeSchema
      .describe(
        "`auto` runs in its stage every turn, or every `schedule.every`-th turn. `manual` runs on an explicit RPC call. `event` runs when `topic` is emitted. Defaults to `auto`.",
      )
      .optional(),
    ...triggerOptionsShape,
  })
  .strict();

/** `schedule.every` of RUNTIME.md. */
export const authoringEverySchema = everySchema;

// ── Input ────────────────────────────────────────────────────────

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
      })
      .describe(
        "Own data namespace to inline. Data of other plugins cannot be read.",
      ),
    as: z
      .string()
      .min(1)
      .meta({
        description: "Tag that wraps the injected block in the prompt.",
        examples: ["<existing-affinity>"],
      }),
    format: z
      .enum(["summary", "full", "ids-only"])
      .optional()
      .default("summary")
      .describe(
        "`summary` lists key, update time and truncated JSON. `ids-only` lists keys. `full` lists complete JSON. Defaults to `summary`.",
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe(
        "Maximum number of entries injected. Above it, half are the oldest and half the most recently updated. Defaults to 50.",
      ),
  })
  .strict();

/**
 * Runtime-export inject — consume a producer runtime's persisted `recordAs`
 * export (the latest revision committed before this execution started). `from`
 * selects the producer by runtime id or capability; `recordAs` names the
 * export key. Cross-execution counterpart to the same-execution `inputs`
 * bindings.
 */
const runtimeExportInjectDeclSchema = z
  .object({
    kind: z.literal("runtime-export"),
    name: bindingNameSchema,
    from: bindingSourceSchema,
    recordAs: z.string().min(1),
    accepts: runtimeJsonSchemaReference.optional(),
    required: z.boolean().optional(),
  })
  .strict();

/**
 * Discriminated union of inject declarations. Every entry declares its source
 * with `kind` so manifest semantics stay explicit.
 */
export const inputInjectDeclSchema = z.discriminatedUnion("kind", [
  pluginDataInjectDeclSchema,
  runtimeExportInjectDeclSchema,
  z.strictObject({
    kind: z.literal("kernel"),
    from: z.literal("turn-digest@1"),
    name: bindingNameSchema,
  }),
]);

const inputConfigSchema = z
  .object({
    /** Runtime-dir-relative JSON Schema path validating the activation payload. */
    schema: runtimeJsonSchemaReference.optional(),
    inject: z.array(inputInjectDeclSchema).optional(),
  })
  .strict();

// ── Output ───────────────────────────────────────────────────────

export const outputKindSchema = z.enum(["story", "system"]);

const outputConfigSchema = z
  .object({
    // The loader resolves public schema URIs and checks path containment.
    // Both forms use the same non-empty string declaration.
    schema: z.string().min(1).optional(),
    recordAs: z.string().optional(),
  })
  .strict();

// ── Plugin data schemas ─────────────────────────────────────────

export const pluginDataNamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
    message:
      "namespace must be a short identifier (letters, digits, underscore, hyphen)",
  });

export const pluginDataSchemaDeclSchema = z
  .object({
    namespace: pluginDataNamespaceSchema.optional(),
    schemaVersion: z.number().int().positive(),
    acceptsWorldData: z.boolean(),
    schema: pluginRelativeJsonSchemaPath.describe(
      "Package-relative path of the JSON Schema that validates each record.",
    ),
    description: z
      .string()
      .describe("What the namespace stores. Read by world authors and tools.")
      .optional(),
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

// ── Plugin datasets ─────────────────────────────────────────────

const datasetOpsSchema = z
  .array(z.enum(DATA_OP_KINDS))
  .min(1)
  .refine(hasUniqueItems, "ops entries must be unique")
  .describe("Operation kinds allowed on this dataset. Defaults to every kind.");

/**
 * Authored `contributes.datasets.<name>`: a typed plugin-data dataset. The name
 * is the plugin-data namespace.
 */
export const pluginDatasetDeclSchema = z.strictObject({
  schema: pluginRelativeJsonSchemaPath.describe(
    "Package-relative JSON Schema that every record of the dataset must satisfy.",
  ),
  key: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe(
      "Top-level record field whose string value is the record's key. Omit when callers choose keys.",
    )
    .optional(),
  ops: datasetOpsSchema.optional(),
});

/** Compiled dataset declaration with defaults resolved. */
const compiledPluginDatasetDeclSchema = z.strictObject({
  namespace: pluginDataNamespaceSchema.describe(
    "Plugin-data namespace; equals the dataset name.",
  ),
  schema: pluginRelativeJsonSchemaPath.describe(
    "Package-relative JSON Schema that every record of the dataset must satisfy.",
  ),
  key: z
    .string()
    .describe("Top-level record field whose string value is the record's key.")
    .optional(),
  ops: datasetOpsSchema,
});

const compiledPluginDatasetMapSchema = z
  .record(pluginDataNamespaceSchema, compiledPluginDatasetDeclSchema)
  .superRefine((datasets, ctx) => {
    for (const [namespace, decl] of Object.entries(datasets)) {
      if (decl.namespace !== namespace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [namespace, "namespace"],
          message: `namespace must match datasets key "${namespace}"`,
        });
      }
    }
  });

// ── Tools ────────────────────────────────────────────────────────

export const toolsConfigSchema = z
  .object({
    builtin: z
      .array(z.string())
      .describe("Names of builtin tools the runtime may call.")
      .optional(),
    /** Names of entry-registered plugin tools this runtime exposes to its LLM. */
    plugin: z
      .array(z.string())
      .describe(
        "Names of this package's own tools the runtime may call. Each must be listed in `contributes.tools`. The runtime of a single-runtime package gets every contributed tool when this is omitted.",
      )
      .optional(),
    /**
     * Deferred tool loading (tool-search). `true` defers the runtime's entire
     * whitelist; a string array defers just those names. Mirrors
     * `ToolsConfig.defer` in types/plugin.ts.
     */
    defer: z
      .union([z.literal(true), z.array(z.string())])
      .describe(
        "Deferred tool loading. `true` defers the whole whitelist; a list defers only those names.",
      )
      .optional(),
  })
  .strict();

// ── Hook declarations ────────────────────────────────────────────

// Validation set derived from the single source of truth (./types/hooks.ts),
// never re-listed by hand — adding an event there extends this schema for free.
export const hookDeclarationSchema = z
  .object({
    event: z.enum(HOOK_EVENTS).describe("Lifecycle event the hook handles."),
    handler: z.string().min(1),
    match: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    timeoutMs: z.number().int().positive().optional(),
    enforce: z
      .enum(["pre", "normal", "post"])
      .describe("Phase the hook runs in. Defaults to `normal`.")
      .optional(),
  })
  .strict();

// ── Contribution shorthands ──────────────────────────────────────

/**
 * A declaration written either as a string or as an object. The string is
 * the common case and expands to the object; the object stays for the fields
 * the string cannot say. An invalid entry reports the problem of the form it
 * was written in, not a bare "invalid input".
 */
function shorthandOrObject<
  Short extends z.ZodType<string>,
  Full extends z.ZodType<object>,
>(
  short: Short,
  full: Full,
  expand: (value: z.output<Short>) => z.output<Full>,
  expected: string,
) {
  return z
    .union([short, full], {
      error: (issue) => {
        const input = (issue as { input?: unknown }).input;
        const branches =
          (issue as { errors?: { message: string; path: PropertyKey[] }[][] })
            .errors ?? [];
        const branch =
          typeof input === "string"
            ? branches[0]
            : input && typeof input === "object" && !Array.isArray(input)
              ? branches[1]
              : undefined;
        if (!branch?.length) return expected;
        return branch
          .map(({ path, message }) =>
            path.length ? `${path.map(String).join(".")}: ${message}` : message,
          )
          .join("; ");
      },
    })
    .transform((value): z.output<Full> =>
      typeof value === "string"
        ? expand(value as z.output<Short>)
        : (value as z.output<Full>),
    );
}

const hookEventSchema = hookDeclarationSchema.shape.event;

/** `contributes.hooks[]`: an event name, or `{ event, enforce }`. */
export const pluginHookContributionSchema = shorthandOrObject(
  hookEventSchema.describe(
    "Lifecycle event the entry registers a handler for, in the default `normal` phase.",
  ),
  hookDeclarationSchema
    .pick({ event: true, enforce: true })
    .describe("A hook in another phase: `{ event, enforce }`."),
  (event) => ({ event }),
  "expected a hook event name, such as PreToolUse, or { event, enforce }",
);

/** `contributes.extensions[]`: `<point>/<id>`, or the object form. */
export const pluginExtensionContributionSchema = shorthandOrObject(
  z
    .string()
    .regex(new RegExp(`^${extensionPointPattern}/${extensionIdPattern}$`), {
      message:
        "an extension written as a string is `<point>/<id>`, such as `prompt.segment@1/notes`",
    })
    .meta({
      description:
        "`<point>/<id>`: the extension point and the ID of this extension in the package, for an entry that sets nothing else.",
      examples: ["prompt.segment@1/notes"],
    }),
  extensionDeclarationSchema.describe(
    "An extension that sets more than its point and ID, such as the `slot` of a `ui.slot@1` provider.",
  ),
  (value) => {
    const slash = value.indexOf("/");
    return { point: value.slice(0, slash), id: value.slice(slash + 1) };
  },
  "expected `<point>/<id>`, such as prompt.segment@1/notes, or { point, id, ... }",
);

// ── Plugin entry path ─────────────────────────────────────

const pluginRelativeJsPath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\/\.\.\/)(?!\.\.\/)[a-zA-Z0-9_./-]+\.[mMcC]?[jJ][sS]$/, {
    message:
      "handler must be a plugin-relative .js/.mjs/.cjs path (no leading `/`, no `..` segments)",
  });

/** PLUGIN.md `entry`: the package's server entry module. */
export const pluginEntryPathSchema = pluginRelativeJsPath.describe(
  "Package-relative path of the server entry module. It registers tools, actions, services, hooks and extensions. Defaults to `./server/index.js` when that file exists.",
);

// ── World projections ─────────────────────────────────────

const worldProjectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, {
    message:
      "projection/output id must start with a lowercase letter and contain only lowercase letters/digits/underscore/hyphen",
  });

const worldProjectionKeyFieldSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, {
    message:
      "key must be a field name starting with a letter and containing only letters/digits/underscore/hyphen",
  });

const worldProjectionOutputDeclSchema = z
  .object({
    namespace: pluginDataNamespaceSchema.describe(
      "Own data namespace that receives the projected records.",
    ),
    key: worldProjectionKeyFieldSchema.describe(
      "Field of each projected record used as its stable key.",
    ),
  })
  .strict();

const worldProjectionOutputsSchema = z
  .record(worldProjectionIdSchema, worldProjectionOutputDeclSchema)
  .refine((outputs) => Object.keys(outputs).length > 0, {
    message: "outputs must declare at least one destination",
  });

const worldProjectionDeclSchema = z
  .object({
    from: z
      .string()
      .trim()
      .min(1)
      .regex(/\S/)
      .describe(
        "Schema URI of the world data source to project. Only sources with exactly this schema are projected.",
      ),
    handler: pluginRelativeJsPath.describe(
      "Package-relative path of the pure projection handler module.",
    ),
    outputs: worldProjectionOutputsSchema.describe(
      "Destinations keyed by output ID. At least one is required.",
    ),
  })
  .strict();

export const worldProjectionMapSchema = z
  .record(worldProjectionIdSchema, worldProjectionDeclSchema)
  .refine((projections) => Object.keys(projections).length > 0, {
    message: "worldProjections must declare at least one projection",
  });

const i18nTextLoose = z.union([z.string(), z.record(z.string(), z.string())]);

// ── Event declarations ──────────────────────────────────────────

const EVENT_TOPIC_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Declares a domain event a plugin's runtime may emit via the builtin
 * `emit-event` tool. The event directory service (apps/server) aggregates
 * these across active plugins per session and validates emitted payloads
 * against `schema` before they enter the same-turn event fan-out.
 */
const pluginEventDeclSchema = z
  .object({
    topic: z
      .string()
      .regex(
        EVENT_TOPIC_RE,
        "event topic must be dot-separated kebab-case (domain.verb)",
      )
      .meta({
        description: "Event topic in dot-separated kebab-case.",
        examples: ["scene.set"],
      }),
    schema: pluginRelativeJsonSchemaPath.describe(
      "Package-relative path of the JSON Schema that validates the event payload.",
    ),
    description: i18nTextLoose.describe(
      "What the event means. Given to runtimes that may emit it.",
    ),
    /** When true (default) the contract is advertised to emitting runtimes. */
    advertise: z
      .boolean()
      .default(true)
      .describe(
        "`true` advertises the event to runtimes that emit events. Defaults to `true`.",
      ),
  })
  .strict();

// A relation entry is a plugin id (or `pluginId/runtimeId`) — nothing more.
// The object form that also accepted `target` / `plugin` / `runtime` / `type` /
// `optional` / `reason` was four ways to spell one id plus three fields no
// consumer read; `capability` / `tag` targets never resolved at all. Annotate a
// dependency with a YAML comment instead. Capability-based *scheduling*
// dependencies are a different field — see `needs` / `after`.
// ── UI spec ─────────────────────────────────────────────────────

/** `contributes.ui`: package-relative paths of UI spec files, by placement. */
export const pluginUiPathsSchema = z
  .object({
    right: z
      .array(z.string().min(1))
      .describe("Paths of UI specs for right-panel tabs.")
      .optional(),
    message: z
      .array(z.string().min(1))
      .describe("Paths of UI specs rendered inside the message stream.")
      .optional(),
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
      })
      .describe("Setting key. Runtimes read it from `ctx.userSettings`."),
    type: z
      .enum([
        "text",
        "textarea",
        "number",
        "integer",
        "toggle",
        "select",
        "slider",
        "slot",
      ])
      .describe(
        "Control type. `select` needs `options`; `slot` lets the player pick a model slot.",
      ),
    // zod 4.4: a bare `z.unknown()` field in ANY object (strict or not) is now
    // treated as a required key (4.3 treated it as optional); `.optional()`
    // keeps the field omittable so plugins can declare a setting with no default.
    default: z
      .unknown()
      .describe("Value used when neither the player nor the world sets one.")
      .optional(),
    label: i18nTextLoose.describe("Label shown in the settings panel."),
    description: i18nTextLoose
      .describe("Help text shown with the control.")
      .optional(),
    min: z.number().describe("Minimum for numeric controls.").optional(),
    max: z.number().describe("Maximum for numeric controls.").optional(),
    step: z.number().describe("Step for numeric controls.").optional(),
    options: z
      .array(
        z.object({
          value: z.string().describe("Stored value of the option."),
          label: i18nTextLoose.describe("Label shown for the option."),
        }),
      )
      .describe("Choices of a `select` control.")
      .optional(),
  })
  .strict();

// ── Scheduling: stage / dependencies / bindings ──────────────────

/** Coarse scheduling stage: which band a runtime runs in. Derived from
 * the canonical STAGE_ORDER tuple so the enum can never drift from it. */
export const stageSchema = z.enum(STAGE_ORDER);

/**
 * Upper bound for one settle barrier. Every later player action may wait this
 * long, so the kernel clamps persisted values to it as well.
 */
export const MAX_SETTLE_WAIT_MS = 120_000;

/** Agent prompt history window, counted in turns of visible history. */
const runtimeHistoryPolicySchema = z.strictObject({
  includeSummaries: z
    .boolean()
    .optional()
    .describe(
      "Include persisted summaries alongside the bounded history window. Defaults to false.",
    ),
  maxTurns: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .describe(
      "Number of most recent turns kept in the agent's prompt history. `0` sends no history.",
    ),
});

/** The options of a detached runtime, as an author writes them. */
export const detachedOptionsSchema = z.strictObject({
  settle: z
    .boolean()
    .describe(
      "`true` makes the next player action wait until this runtime's job has finished, for at most `maxSettleWaitMs`. Defaults to `false`.",
    )
    .optional(),
  maxSettleWaitMs: z
    .number()
    .int()
    .positive()
    .max(MAX_SETTLE_WAIT_MS)
    .describe(
      `Longest time in ms the next action waits for the job, at most ${MAX_SETTLE_WAIT_MS}. Requires \`settle: true\`.`,
    )
    .optional(),
  maxQueueMs: z
    .number()
    .int()
    .positive()
    .describe("Longest time in ms the job may wait in the queue.")
    .optional(),
  maxExecutionMs: z
    .number()
    .int()
    .positive()
    .describe("Longest time in ms the job may run.")
    .optional(),
});

/**
 * Scheduler-driven turn-barrier policy of the compiled IR. Kept separate from
 * `execution`, whose meaning is the manual/event activation mode.
 */
const turnCompletionConfigSchema = detachedOptionsSchema.extend({
  mode: z
    .enum(["await", "detached"])
    .describe(
      "`await` makes the turn wait for this runtime. `detached` lets the turn finish first. Defaults to `await`.",
    )
    .optional(),
});

/**
 * `after` entry — weak ordering, no gate. A bare string is shorthand for
 * `{ runtime }`; the object form is a {@link bindingSourceSchema} (runtime XOR
 * capability). `scope` is intentionally NOT accepted on `after` entries.
 */
const afterRefSchema = z.union([z.string().min(1), bindingSourceSchema]);

/**
 * `needs` entry — ordering + gate. Adds an optional `scope` (turn/session) to
 * either a runtime or capability ref; `cardinality` stays capability-only.
 */
const needsRefSchema = z.union([
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
const runtimeBindingSchema = z
  .object({
    from: bindingSourceSchema,
    select: jsonPointerSchema.optional(),
    required: z.boolean().optional(),
    accepts: runtimeJsonSchemaReference.optional(),
  })
  .strict();

const inputsBindingMapSchema = z.record(
  bindingNameSchema,
  runtimeBindingSchema,
);

// ── Result format ────────────────────────────────────────────────

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
const effectResourceSchema = z.union([
  z.enum([
    "state:*",
    "narrative:*",
    "characters:*",
    "assets:*",
    "media:*",
    "lorebook:*",
    "ui:*",
    "interaction:*",
    "unknown:*",
  ]),
  z.string().regex(/^plugin-data:self:[a-zA-Z_][a-zA-Z0-9_-]*$/, {
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
      .describe(
        "Resources the runtime reads, such as `narrative:*` or `plugin-data:self:<namespace>`. Entries must be unique.",
      )
      .optional(),
    writes: z
      .array(effectResourceSchema)
      .refine(hasUniqueItems, "writes entries must be unique")
      .describe(
        "Resources the runtime writes, such as `state:*` or `event:<topic>`. Entries must be unique.",
      )
      .optional(),
    parallelSafe: z
      .boolean()
      .describe(
        "`true` states that the runtime is safe to run in parallel with its stage siblings.",
      )
      .optional(),
  })
  .strict();

// ── HTTP permission declaration ──────────────────────────────────

const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);

const httpPermissionDeclSchema = z
  .object({
    origin: z
      .string()
      .regex(/^https:\/\/[^/?#@]+$/, {
        message:
          "origin must be a canonical https origin (no path, query, or credentials)",
      })
      .meta({
        description:
          "HTTPS origin the runtime may call, without path, query or credentials.",
        examples: ["https://api.example.com"],
      }),
    methods: z
      .array(httpMethodSchema)
      .min(1)
      .refine(hasUniqueItems, "methods must be unique")
      .describe("HTTP methods allowed for the origin. Entries must be unique.")
      .optional(),
  })
  .strict();

export const permissionsDeclSchema = z
  .object({
    http: z
      .array(httpPermissionDeclSchema)
      .describe(
        "Upper bound of the HTTP origins and methods the runtime may use.",
      )
      .optional(),
  })
  .strict();

// ── Cross-field constraints ──────────────────────────────────────

/** Fields of the flat IR shape that the shared runtime rules read. */
interface ManifestCrossFieldView {
  readonly outputContract?: string;
  readonly defaultProvider?: boolean;
  readonly runtimeType?: string;
  readonly handler?: string;
  readonly stage?: string;
  readonly outputKind?: string;
  readonly requireExplicitCompletion?: boolean;
  readonly turnCompletion?: NonNullable<RuntimeRuleView["detached"]> & {
    readonly mode?: string;
  };
  readonly trigger?: RuntimeRuleView["trigger"] & { readonly every?: number };
  readonly needs?: RuntimeRuleView["needs"];
  readonly output?: RuntimeRuleView["output"];
  readonly execution?: string;
  readonly tools?: { readonly builtin?: readonly string[] };
}

/** Report the shared runtime rules on the flat IR shape, under IR paths. */
function addIrRuleIssues(
  m: ManifestCrossFieldView,
  ctx: z.RefinementCtx,
): void {
  const { outputKind, turnCompletion, execution, tools, ...rest } = m;
  const { mode, ...detachedOptions } = turnCompletion ?? {};
  for (const issue of runtimeRuleIssues(
    {
      ...rest,
      every: m.trigger?.every,
      visibility: outputKind,
      ...(mode === "detached" ? { detached: detachedOptions } : {}),
      background: execution === "background",
      builtinTools: tools?.builtin,
    },
    IR_RULE_FIELD_PATHS,
  ))
    ctx.addIssue({
      code: "custom",
      path: [...issue.path],
      message: issue.message,
    });
  // Only the IR spells the mode out: an authored runtime writes the options
  // inside `schedule.detached`.
  if (mode !== "detached" && Object.keys(detachedOptions).length > 0)
    ctx.addIssue({
      code: "custom",
      path: ["turnCompletion", "mode"],
      message:
        "the detached options of turnCompletion require turnCompletion.mode 'detached'",
    });
}

// ── Package-level fields ─────────────────────────────────────────
// PLUGIN.md declares these once for the package (plugin-manifest.ts); they
// are not part of a compiled runtime.

/** PLUGIN.md `description`: a plain string, or a locale map. */
export const pluginDescriptionSchema = z
  .union([
    z.string().min(1),
    z
      .record(z.string(), z.string().min(1))
      .refine((m) => Object.keys(m).length > 0, {
        message: "i18n description map must have at least one locale entry",
      }),
  ])
  .describe(
    "What the package does. Plain string; translations go in locale files.",
  );

/** PLUGIN.md `displayName`: the name players see, distinct from the id. */
export const pluginDisplayNameSchema = i18nTextLoose.describe(
  "Player-facing name. Plain string; translations go in locale files.",
);

/** `contributes.events`: domain events the package's runtimes may emit. */
export const pluginEventsSchema = z
  .array(pluginEventDeclSchema)
  .describe(
    "Domain events the package's runtimes may emit with the builtin `emit-event` tool.",
  );

/** `contributes.settings`: the package's player settings. */
export const pluginUserSettingsSchema = z
  .array(pluginUserSettingSpecSchema)
  .describe(
    "Player-configurable settings. A world can preset them with `pluginSettings`.",
  );

/** `contributes.commands`: the package's player slash commands. */
export const pluginCommandsSchema = z
  .array(slashCommandSpecSchema)
  .max(32)
  .describe(
    "Player slash commands. Each `action` must be listed in `actions`.",
  );

// ── Compiled runtime manifest ────────────────────────────────────

/**
 * The compiled RuntimeManifest: the internal form the loader produces from a
 * RUNTIME.md or an inline `runtime`, one per runtime. It is not an authoring
 * format — authors write the grouped form in runtime-manifest.ts. The loader
 * copies the package's `userSettings` and `dataSchemas` onto each runtime;
 * every other package-level field stays on the package declaration.
 */
export const runtimeManifestInputSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/, {
        message:
          'name must be lowercase with hyphens, optional slash separators (e.g. "my-runtime" or "my-plugin/sub-runtime")',
      }),
    /** The loader folds a locale map to the English string after parse. */
    description: pluginDescriptionSchema,
    version: z.string().optional(),
    runtimeType: z.enum(["agent", "function"]).optional(),
    handler: z.string().optional(),
    guard: z.string().optional(),
    model: z.string().optional(),
    llm: z
      .strictObject({
        reasoningEffort: z
          .literal("disabled")
          .describe("`disabled` turns model reasoning off for this runtime.")
          .optional(),
        toolChoice: z
          .union([
            z.literal("required"),
            z.strictObject({
              name: z.string().min(1).describe("Name of the tool to force."),
            }),
          ])
          .describe(
            "`required` forces a tool call on every step. `{ name }` forces one named tool.",
          )
          .optional(),
      })
      .describe("Model call options for this runtime.")
      .optional(),
    /** Bounded agent prompt history; omitted keeps the shared session view. */
    history: runtimeHistoryPolicySchema
      .describe(
        "Bounds the agent's prompt history. When omitted, the runtime sees the shared session history.",
      )
      .optional(),
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
    /** Total timeout of one non-streaming LLM call (ms). */
    callTimeoutMs: z.number().int().positive().optional(),
    /**
     * Streaming first-token (TTFB) timeout (ms). Default: at most 120000,
     * shortened so the retries left fit into `timeoutMs`.
     */
    firstTokenTimeoutMs: z.number().int().positive().optional(),
    /** Longest silence of a stream that has started to write (ms). Default 120000. */
    idleTimeoutMs: z.number().int().positive().optional(),
    /** Tool-call loop detection threshold. Default 3. Set 0 to disable. */
    loopDetectionThreshold: z.number().int().min(0).max(20).optional(),
    /** Retry a bare (no-tool-call) finish once before releasing. Default false. */
    requireToolUse: z.boolean().optional(),
    /** Require a completing tool or explicit runtime-done, preserving no-change. */
    requireExplicitCompletion: z.boolean().optional(),
    /** Complete after a response batch successfully calls one of these tools. */
    completeAfterTools: z.array(z.string().min(1)).min(1).optional(),
    /** Maximum nested ctx.recursiveCall() depth. Default 10. */
    maxRecursionDepth: z.number().int().min(0).max(50).optional(),
    outputKind: outputKindSchema.optional(),
    concealed: z.boolean().optional(),
    outputContract: z.string().min(1).optional(),
    defaultProvider: z.boolean().optional(),
    /** Coarse scheduling stage: which band this runtime runs in. */
    stage: stageSchema.optional(),
    /** Weak ordering dependencies (no gate). */
    after: z.array(afterRefSchema).optional(),
    /** Strong dependencies: ordering + gate. */
    needs: z.array(needsRefSchema).optional(),
    /** Typed same-execution data bindings, keyed by local binding name. */
    inputs: inputsBindingMapSchema.optional(),
    /** Explicit read/write-set override for parallel hazard detection. */
    effects: effectsDeclSchema.optional(),
    /** Declared permission upper bounds (currently HTTP origins + methods). */
    permissions: permissionsDeclSchema.optional(),
    /**
     * Execution mode when activated via manual plugin-rpc or as an event
     * follower (`sync` awaits, `background` queues a durable runtime job and
     * returns its jobId). Ignored for scheduler-driven runtimes.
     */
    execution: z.enum(["sync", "background"]).optional(),
    /** Scheduler-driven foreground turn-barrier policy. */
    turnCompletion: turnCompletionConfigSchema.optional(),
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
    trigger: triggerConfigSchema.optional(),
    /** Copied from the package by the loader. */
    dataSchemas: pluginDataSchemaMapSchema.optional(),
    /** Copied from the package by the loader. */
    datasets: compiledPluginDatasetMapSchema.optional(),
    /** Copied from the package by the loader. */
    userSettings: pluginUserSettingsSchema.optional(),
  })
  .superRefine((m, ctx) => addIrRuleIssues(m, ctx));
