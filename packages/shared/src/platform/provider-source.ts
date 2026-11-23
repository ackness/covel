import { z } from "zod";
import type { PluginProviderSourceRequestShape } from "@covel/plugin-handlers-utils";
import { isProviderProtocolId } from "../provider-protocols.js";
import { isLoopbackBaseUrl } from "../utils/provider-defaults.js";
import {
  createPlatformIdSchema,
  PLATFORM_ID_RE,
  platformTextSchema,
} from "./primitives.js";

export const PROVIDER_SOURCE_ID_RE = PLATFORM_ID_RE;

export const providerSourceIdSchema =
  createPlatformIdSchema("Provider source ID");

export const PROVIDER_SOURCE_MODES = [
  "text",
  "object",
  "stream",
  "embed",
  "image",
  "speech",
  "transcription",
  "music",
  "evaluate",
] as const;

export type ProviderSourceMode = (typeof PROVIDER_SOURCE_MODES)[number];

/** Check whether a provider source supports a requested gateway operation mode. */
export function providerSourceSupportsMode(
  declaredModes: readonly ProviderSourceMode[] | undefined,
  mode: ProviderSourceMode,
): boolean {
  const effective: readonly ProviderSourceMode[] =
    declaredModes && declaredModes.length > 0 ? declaredModes : ["text"];
  if (effective.includes(mode)) return true;
  // Text sources naturally back structured object extraction and SSE text streams.
  if ((mode === "object" || mode === "stream") && effective.includes("text")) {
    return true;
  }
  return false;
}

const QUALIFIED_PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

export function qualifiedProviderSourceId(
  pluginId: string,
  sourceId: string,
): string {
  return `${pluginId}/${sourceId}`;
}

export function parseQualifiedProviderSourceId(
  ref: string,
): { readonly pluginId: string; readonly sourceId: string } | null {
  if (typeof ref !== "string") return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  if (ref.indexOf("/", slash + 1) !== -1) return null;
  const pluginId = ref.slice(0, slash);
  const sourceId = ref.slice(slash + 1);
  if (!QUALIFIED_PLUGIN_ID_RE.test(pluginId)) return null;
  if (!PROVIDER_SOURCE_ID_RE.test(sourceId)) return null;
  return { pluginId, sourceId };
}

export function isAllowedProviderSourceBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && isLoopbackBaseUrl(url);
  } catch {
    return false;
  }
}

const providerSourceEndpointPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"))
  .refine(
    (value) =>
      !/[?#\\\s]/.test(value) &&
      ![...value].some((character) => character.charCodeAt(0) < 32) &&
      !value.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment)),
  );

/**
 * Validates a relative endpoint path appended verbatim to a provider source's
 * declared `baseUrl` (rejects query/fragment/backslash/traversal/protocol-relative paths).
 */
export function isValidProviderSourceEndpointPath(value: unknown): boolean {
  return providerSourceEndpointPathSchema.safeParse(value).success;
}

const authFlowRefSchema = createPlatformIdSchema("Auth flow ID");

export const providerSourceContributionSchema = z.strictObject({
  id: providerSourceIdSchema.describe(
    "Identifier of this provider source within the package (qualified as `<pluginId>/<id>` in slot configuration).",
  ),
  label: platformTextSchema.describe(
    "Human-readable display name shown in provider configuration UI (string or locale map).",
  ),
  protocol: z
    .string()
    .min(1)
    .refine(isProviderProtocolId, {
      message:
        "Unknown protocol: use a built-in protocol ID, or <pluginId>/<wireId> for a plugin's text protocol",
    })
    .describe(
      "Wire protocol spoken by this provider source. Defaults to `openai-responses-v1` when resolved if omitted.",
    )
    .optional(),
  modes: z
    .array(z.enum(PROVIDER_SOURCE_MODES))
    .min(1)
    .refine((items) => new Set(items).size === items.length, {
      message: "providerSource modes must be unique",
    })
    .describe(
      'Supported gateway modes for this source (`"text"` implies `"object"` and `"stream"`). Defaults to `["text"]`.',
    )
    .optional(),
  baseUrl: z
    .string()
    .url()
    .refine(isAllowedProviderSourceBaseUrl, {
      message:
        "baseUrl must use https:// (or http:// on loopback) without embedded credentials",
    })
    .describe(
      "Canonical base URL declared by the package; runtime requests are origin-locked to this URL.",
    ),
  auth: z
    .strictObject({
      flows: z
        .array(authFlowRefSchema)
        .min(1)
        .describe(
          "Declarative Config Flow IDs in this package that authenticate or manage this source.",
        ),
    })
    .describe(
      "Authentication Config Flows associated with this provider source.",
    )
    .optional(),
  accounts: z
    .enum(["one", "many"])
    .describe(
      'Whether this source manages a single account (`"one"`, default) or multiple switchable accounts (`"many"`).',
    )
    .optional(),
});

export type ProviderSourceContribution = z.infer<
  typeof providerSourceContributionSchema
>;

export interface ProviderSourceCredentialStatus {
  readonly sourceId: string;
  readonly accountId?: string;
  readonly ready: boolean;
  readonly reason?: string;
}

export interface ProviderSourceAccountSummary {
  readonly id: string;
  readonly label?: string;
  readonly status: "ready" | "needs_reauth" | "disabled" | "rate_limited";
  readonly isDefault?: boolean;
  readonly expiresAt?: string;
  readonly updatedAt?: string;
  readonly plan?: string;
}

export interface ProviderSourceUsageSummary {
  readonly accountId?: string;
  readonly label?: string;
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetAt?: string;
  readonly summary?: string;
  readonly windows?: readonly {
    readonly name: string;
    readonly usedPercent?: number;
    readonly remainingPercent?: number;
    readonly resetAt?: string;
  }[];
}

export type ProviderSourceRequestShape = PluginProviderSourceRequestShape;

export interface ProviderSourceSummary {
  readonly id: string;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly label: string | Readonly<Record<string, string>>;
  readonly protocol: string;
  readonly modes: readonly ProviderSourceMode[];
  readonly baseUrl: string;
  readonly accountsMode: "one" | "many";
  readonly authFlows: readonly string[];
  readonly ready: boolean;
  readonly reason?: string;
  readonly accounts: readonly ProviderSourceAccountSummary[];
}
