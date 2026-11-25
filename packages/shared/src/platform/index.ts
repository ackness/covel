import { z } from "zod";

export const PLUGIN_API_VERSION = 2;
export const SUPPORTED_PLUGIN_API_VERSIONS = [1, 2] as const;

export function isSupportedPluginApiVersion(version: number): boolean {
  return (SUPPORTED_PLUGIN_API_VERSIONS as readonly number[]).includes(version);
}

export const PLUGIN_SCOPES = ["session", "instance", "both"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

export const GLOBAL_SESSION_DEFAULTS = ["off", "optional"] as const;
export type GlobalSessionDefault = (typeof GLOBAL_SESSION_DEFAULTS)[number];

export const APP_EVENT_NAMES = [
  "AppStarted",
  "BeforeShutdown",
  "SessionCreated",
  "SessionTurnCommitted",
  "SessionDeleted",
  "WorldInstalled",
  "WorldRemoved",
] as const;
export type AppEventName = (typeof APP_EVENT_NAMES)[number];

const APP_EVENT_ALTERNATIVES = APP_EVENT_NAMES.join("|");

export const ACTIVATION_EVENT_RE = new RegExp(
  `^(?:onStartup|onSettingsView|onAppAction:[a-z0-9][a-z0-9-_]{0,63}|onAppEvent:(?:${APP_EVENT_ALTERNATIVES})|onExtension:[a-z][a-z0-9.-]*@[1-9][0-9]*|onFlow:[a-z0-9][a-z0-9-_]{0,63}|onSchedule:[a-z0-9][a-z0-9-_]{0,63})$`,
);

export const activationEventSchema = z.string().regex(ACTIVATION_EVENT_RE, {
  message:
    "activationEvent must be onStartup, onSettingsView, onAppAction:<id>, onAppEvent:<event>, onExtension:<contract@v>, onFlow:<id>, or onSchedule:<id>",
});

export type ActivationEvent = z.infer<typeof activationEventSchema>;

export const loopbackCallbackPermissionSchema = z.strictObject({
  path: z
    .string()
    .regex(/^\/[a-zA-Z0-9._/-]*$/, {
      message: "loopbackCallback.path must start with `/` and use path chars",
    })
    .refine((value) => !value.includes(".."), {
      message: "loopbackCallback.path must not contain `..`",
    })
    .describe("Loopback HTTP path mounted on localhost during authorization."),
  ports: z
    .union([
      z.literal("ephemeral"),
      z
        .array(z.number().int().min(1024).max(65535))
        .min(1)
        .max(8)
        .refine((arr) => new Set(arr).size === arr.length, {
          message: "loopbackCallback.ports must be unique",
        }),
    ])
    .describe(
      'Port strategy (`"ephemeral"` default) or ordered fallback port list.',
    )
    .optional(),
});

export type LoopbackCallbackPermission = z.infer<
  typeof loopbackCallbackPermissionSchema
>;

export type { PlatformText } from "./primitives.js";
export type {
  JsonValue as PluginJsonValue,
  PluginConfigFlowFieldOption,
  PluginConfigFlowStartInput,
  PluginConfigFlowStepInput,
  PluginInstanceDataEntry,
  PluginInstanceDataStore,
  PluginLoopbackCallbackResult,
  PluginLoopbackCallbackSession,
  PluginProviderSourceRefreshRequest,
  PluginSandboxWorkerRunner,
  PluginSchedulerClient,
  PluginSecretEntry,
  PluginSecretStore,
  PluginSecretSummary,
} from "@covel/plugin-handlers-utils";

export * from "./config-flows.js";
export * from "./prompt-governance.js";
export * from "./ui-mounts.js";
export * from "./app-runtime.js";
export * from "./channel-bridge.js";
export * from "./provider-source.js";
