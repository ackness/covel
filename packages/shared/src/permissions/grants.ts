import { z } from "zod";
import {
  capabilitiesWithin,
  pluginCapabilitiesSchema,
  type PluginCapabilities,
} from "../schemas/trusted-sources.js";
import { isLoopbackBaseUrl } from "../utils/provider-defaults.js";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  isCapabilityKey,
  type CapabilityGrantDecision,
  type CapabilityKey,
} from "./catalog.js";

export const pluginCapabilityGrantDecisionSchema = z.enum(["allow", "deny"]);
export type PluginCapabilityGrantDecision = z.infer<
  typeof pluginCapabilityGrantDecisionSchema
>;

export type PluginGrantDecisions = Partial<
  Record<CapabilityKey, PluginCapabilityGrantDecision>
>;

/**
 * Validated per-plugin persistent capability decisions, canonically ordered by
 * `CAPABILITY_KEYS` and rejecting unknown or reserved keys.
 */
export const pluginGrantDecisionsSchema: z.ZodType<PluginGrantDecisions> = z
  .record(z.string(), pluginCapabilityGrantDecisionSchema)
  .superRefine((record, ctx) => {
    for (const key of Object.keys(record)) {
      if (!isCapabilityKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Unknown capability key "${key}"`,
        });
        continue;
      }
      if (CAPABILITY_CATALOG[key].reserved) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Capability "${key}" is reserved and cannot be assigned a plugin grant`,
        });
      }
    }
  })
  .transform((record) => {
    const out: PluginGrantDecisions = {};
    for (const key of CAPABILITY_KEYS) {
      const decision = record[key];
      if (decision !== undefined) {
        out[key] = decision;
      }
    }
    return out;
  });

export const pluginGrantRecordSchema = z.strictObject({
  pluginId: z.string().min(1),
  version: z.string().min(1),
  contentDigest: z.string().min(1),
  grantedCapabilities: pluginCapabilitiesSchema,
  decisions: pluginGrantDecisionsSchema,
  grantedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export interface PluginGrantRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly grantedCapabilities: PluginCapabilities;
  readonly decisions: PluginGrantDecisions;
  readonly grantedAt: string;
  readonly updatedAt: string;
}

export type PluginGrantStatus =
  "none" | "valid" | "stale-digest" | "capability-escalated" | "unreadable";

/**
 * Evaluate whether a stored L3 persistent grant still binds cleanly to the
 * live package's digest and declared capability snapshot.
 */
export function evaluatePluginGrantValidity(input: {
  readonly grant: PluginGrantRecord | null | undefined;
  readonly currentDigest: string | undefined;
  readonly currentCapabilities: PluginCapabilities | undefined;
}): PluginGrantStatus {
  const { grant, currentDigest, currentCapabilities } = input;
  if (!grant) return "none";
  if (!currentDigest || !currentCapabilities) return "unreadable";
  if (!capabilitiesWithin(currentCapabilities, grant.grantedCapabilities)) {
    return "capability-escalated";
  }
  if (currentDigest !== grant.contentDigest) {
    return "stale-digest";
  }
  return "valid";
}

/**
 * Resolve one capability's L3 grant decision. Explicit `"deny"` stays sticky
 * even across stale digests or capability escalation until cleared or updated;
 * `"allow"` requires a currently valid grant.
 */
export function pluginGrantDecisionFor(
  status: PluginGrantStatus | "builtin",
  grant: PluginGrantRecord | null | undefined,
  key: CapabilityKey,
): CapabilityGrantDecision {
  const explicit = grant?.decisions[key];
  if (explicit === "deny") return "deny";
  if (status === "valid" && explicit === "allow") return "allow";
  return "unset";
}

/**
 * Derive the ordered, deduplicated set of host capabilities relevant to a
 * plugin from its execution tier and current capability declarations.
 */
export function derivePluginRequestedCapabilities(input: {
  readonly tier: 0 | 3;
  readonly capabilities: PluginCapabilities | null | undefined;
}): readonly CapabilityKey[] {
  const { tier, capabilities } = input;
  const keys = new Set<CapabilityKey>();

  if (tier === 0) {
    keys.add("plugin.declarative");
  }
  if (tier === 3 || capabilities?.serverCode) {
    keys.add("plugin.communityCode");
  }
  if (capabilities) {
    if (capabilities.instanceScope) {
      keys.add("plugin.instanceScope");
    }
    if ((capabilities.providerSources?.length ?? 0) > 0) {
      keys.add("plugin.providerSource");
    }
    if (capabilities.secrets) {
      keys.add("secrets.own");
    }
    if (capabilities.authProxy) {
      keys.add("net.authProxy");
    }
    if (capabilities.loopbackCallback) {
      keys.add("net.loopbackCallback");
    }
    if (capabilities.scheduler) {
      keys.add("app.scheduler");
    }
    if (capabilities.sandboxWorker) {
      keys.add("compute.sandboxWorker");
    }
    if (
      capabilities.extensions.some((ext) =>
        ext.startsWith("channel.bridge@1/"),
      ) ||
      capabilities.services.some((svc) => svc.startsWith("channel.bridge@1"))
    ) {
      keys.add("channel.bridge");
    }
    if (capabilities.http.length > 0) {
      keys.add("net.httpDeclared");
      if (capabilities.http.some((item) => isLoopbackBaseUrl(item.origin))) {
        keys.add("network.localModels");
      }
    }
  }

  return CAPABILITY_KEYS.filter((key) => keys.has(key));
}
