import { z } from "zod";
import { readEnvString, type EnvSource } from "../env/registry-readers.js";
import type { ServerSettingDefinition } from "../env/server-setting.js";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  capabilityPolicyModeSchema,
  isCapabilityKey,
  type CapabilityKey,
  type CapabilityPolicyMode,
} from "./catalog.js";

export const PERMISSIONS_POLICY_SETTING_KEY = "permissions.policy";

export type PermissionsPolicyOverrides = Partial<
  Record<CapabilityKey, CapabilityPolicyMode>
>;

export const DEFAULT_PERMISSIONS_POLICY: Readonly<
  Record<CapabilityKey, CapabilityPolicyMode>
> = Object.fromEntries(
  CAPABILITY_KEYS.map((key) => [key, CAPABILITY_CATALOG[key].defaultPolicy]),
) as Record<CapabilityKey, CapabilityPolicyMode>;

/**
 * Validate and normalize instance-level capability policy overrides:
 * - Rejects unknown capability keys.
 * - Rejects `"allow"` for capabilities where `allowAutoPolicy` is false.
 * - Drops entries matching `defaultPolicy` and sorts in canonical key order.
 */
export const permissionsPolicySchema: z.ZodType<PermissionsPolicyOverrides> = z
  .record(z.string(), capabilityPolicyModeSchema)
  .superRefine((record, ctx) => {
    for (const [key, mode] of Object.entries(record)) {
      if (!isCapabilityKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Unknown capability key "${key}"`,
        });
        continue;
      }
      if (
        CAPABILITY_CATALOG[key].reserved &&
        mode !== CAPABILITY_CATALOG[key].defaultPolicy
      ) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Capability "${key}" is reserved and cannot be changed from "${CAPABILITY_CATALOG[key].defaultPolicy}"`,
        });
        continue;
      }
      if (mode === "allow" && !CAPABILITY_CATALOG[key].allowAutoPolicy) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Capability "${key}" cannot default to "allow" at instance policy level`,
        });
      }
    }
  })
  .transform((record) => {
    const out: PermissionsPolicyOverrides = {};
    for (const key of CAPABILITY_KEYS) {
      const mode = record[key];
      if (mode !== undefined && mode !== DEFAULT_PERMISSIONS_POLICY[key]) {
        out[key] = mode;
      }
    }
    return out;
  });

/**
 * Parse `COVEL_PERMISSIONS_POLICY` (`CapabilityKey=allow|ask|deny,...`) into
 * normalized L2 overrides, returning `undefined` when unset, blank, or invalid.
 */
export function permissionsPolicyFromEnv(
  source?: EnvSource,
): PermissionsPolicyOverrides | undefined {
  const raw = readEnvString("COVEL_PERMISSIONS_POLICY", undefined, source);
  if (raw === undefined) return undefined;
  const segments = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (segments.length === 0) return undefined;
  const candidate: Record<string, string> = {};
  for (const segment of segments) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex <= 0 || eqIndex === segment.length - 1) return undefined;
    const key = segment.slice(0, eqIndex).trim();
    const mode = segment.slice(eqIndex + 1).trim();
    if (!key || !mode || mode.includes("=")) return undefined;
    candidate[key] = mode;
  }
  const parsed = permissionsPolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Merge normalized instance policy overrides onto catalog defaults. */
export function resolvePermissionsPolicy(
  overrides?: PermissionsPolicyOverrides,
): Record<CapabilityKey, CapabilityPolicyMode> {
  const merged = { ...DEFAULT_PERMISSIONS_POLICY };
  if (!overrides) return merged;
  for (const key of CAPABILITY_KEYS) {
    const override = overrides[key];
    if (override !== undefined) {
      merged[key] = override;
    }
  }
  return merged;
}

export const PERMISSIONS_POLICY_SERVER_SETTING: ServerSettingDefinition<PermissionsPolicyOverrides> =
  {
    key: PERMISSIONS_POLICY_SETTING_KEY,
    schema: permissionsPolicySchema,
    default: {},
    operatorValue: permissionsPolicyFromEnv,
  };
