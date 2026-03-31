import { z } from "zod";
import type { PluginManifest } from "@covel/shared";

// ── Zod schemas matching PluginManifest ────────────────────────────

const i18nTextSchema = z.union([z.string(), z.record(z.string())]);

const runtimeTriggerSpecSchema = z.object({
  mode: z.enum(["always", "interval", "manual", "event"]),
  intervalTurns: z.number().int().positive().optional(),
  onEvents: z.array(z.string()).optional(),
});

const runtimeBudgetSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

const runtimeIsolationSchema = z.object({
  readScopes: z.array(z.string()).optional(),
  writeScopes: z.array(z.string()).optional(),
});

const runtimeOutputSpecSchema = z.object({
  proposalKinds: z.array(z.string()).optional(),
});

const publicRuntimeSpecSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  kind: z.enum(["story", "plugin", "background", "verifier"]),
  phase: z.enum(["pre_story", "story", "post_story", "background"]),
  trigger: runtimeTriggerSpecSchema,
  providerBinding: z.string().optional(),
  instructionsRef: z.string().optional(),
  tools: z.array(z.string()),
  hooks: z.array(z.string()),
  budget: runtimeBudgetSchema.optional(),
  output: runtimeOutputSpecSchema.optional(),
  failurePolicy: z.enum(["continue", "stop", "retry", "disable_runtime"]).optional(),
  isolation: runtimeIsolationSchema.optional(),
});

const publicToolDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "query", "mutate", "emit", "render",
    "generate", "orchestration", "script", "proxy",
  ]),
  schema: z.unknown().optional(),
  permissions: z.array(z.string()).optional(),
});

const hookMatchSchema = z.object({
  toolIds: z.array(z.string()).optional(),
  runtimeIds: z.array(z.string()).optional(),
  pluginIds: z.array(z.string()).optional(),
});

const publicHookDefinitionSchema = z.object({
  id: z.string().min(1),
  event: z.enum([
    "TurnStart", "PreToolUse", "PostToolUse",
    "PreStateCommit", "PostStateCommit", "TurnStop",
  ]),
  handlerKind: z.enum(["command", "prompt", "async-command"]),
  match: hookMatchSchema.optional(),
});

const publicUiExtensionSchema = z.object({
  id: z.string().min(1),
  slot: z.enum(["settings_panel", "message_block", "world_panel", "action_panel"]),
  component: z.unknown(),
  propsSchema: z.unknown().optional(),
});

const publicProviderBindingSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["llm", "image", "tts", "script-host"]),
  configRef: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

const runtimeSettingFieldSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["string", "number", "integer", "boolean", "enum"]),
  label: i18nTextSchema,
  description: i18nTextSchema.optional(),
  scope: z.enum(["project", "run", "request"]).optional(),
  component: z.enum(["input", "textarea", "toggle", "select"]).optional(),
  default: z.unknown().optional(),
  options: z
    .array(
      z.object({
        label: i18nTextSchema,
        value: z.union([z.string(), z.number(), z.boolean()]),
      })
    )
    .optional(),
  affects: z.array(z.string()).optional(),
});

export const pluginManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  id: z.string().min(1),
  displayName: i18nTextSchema,
  version: z.string().min(1),
  author: z.string().min(1),
  description: i18nTextSchema,
  defaultLocale: z.string().min(1),
  supportedLocales: z.array(z.string()).min(1),
  loadingOrder: z.number().int().optional(),
  requires: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
  conflicts: z.array(z.string()).optional(),
  compatibility: z.record(z.string()).optional(),
  runtimes: z.array(publicRuntimeSpecSchema).optional(),
  tools: z.array(publicToolDefinitionSchema).optional(),
  hooks: z.array(publicHookDefinitionSchema).optional(),
  ui: z.array(publicUiExtensionSchema).optional(),
  runtimeSettings: z.array(runtimeSettingFieldSchema).optional(),
  permissions: z.array(z.string()).optional(),
  providers: z.array(publicProviderBindingSchema).optional(),
});

/** Validation result. */
export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/**
 * Validate a raw object against the PluginManifest schema.
 */
export function validateManifest(data: unknown): ManifestValidationResult {
  const result = pluginManifestSchema.safeParse(data);
  if (result.success) {
    return { ok: true, manifest: result.data as PluginManifest };
  }
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    ),
  };
}
