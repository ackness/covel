import { z } from "zod";

/**
 * Canonical catalog of host-governed capabilities across all deployment forms,
 * instance policies, per-plugin persistent grants, and session approvals.
 */
export const CAPABILITY_KEYS = [
  "plugin.declarative",
  "compute.sandboxWorker",
  "plugin.communityCode",
  "plugin.instanceScope",
  "plugin.providerSource",
  "channel.bridge",
  "plugin.globalAutoEnable",
  "secrets.own",
  "net.httpDeclared",
  "net.authProxy",
  "net.loopbackCallback",
  "network.localModels",
  "session.bridgeWrite",
  "runtime.highRiskTools",
  "app.scheduler",
  "host.installPackages",
  "exec.localBridge",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type CapabilityCeiling = "enabled" | "operator-only" | "disabled";
export type CapabilityPolicyMode = "allow" | "ask" | "deny";
export type CapabilityGrantDecision = "allow" | "deny" | "unset";

export interface CapabilityDefinition {
  readonly key: CapabilityKey;
  readonly risk: CapabilityRisk;
  readonly defaultPolicy: CapabilityPolicyMode;
  /** Whether an instance policy may set this capability to `"allow"` by default. */
  readonly allowAutoPolicy: boolean;
}

export const capabilityKeySchema = z.enum(CAPABILITY_KEYS);
export const capabilityCeilingSchema = z.enum([
  "enabled",
  "operator-only",
  "disabled",
]);
export const capabilityPolicyModeSchema = z.enum(["allow", "ask", "deny"]);

const CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(CAPABILITY_KEYS);

export function isCapabilityKey(value: string): value is CapabilityKey {
  return CAPABILITY_KEY_SET.has(value);
}

export const CAPABILITY_CATALOG: Readonly<
  Record<CapabilityKey, CapabilityDefinition>
> = {
  "plugin.declarative": {
    key: "plugin.declarative",
    risk: "low",
    defaultPolicy: "allow",
    allowAutoPolicy: true,
  },
  "compute.sandboxWorker": {
    key: "compute.sandboxWorker",
    risk: "low",
    defaultPolicy: "ask",
    allowAutoPolicy: true,
  },
  "plugin.communityCode": {
    key: "plugin.communityCode",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "plugin.instanceScope": {
    key: "plugin.instanceScope",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "plugin.providerSource": {
    key: "plugin.providerSource",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "channel.bridge": {
    key: "channel.bridge",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "plugin.globalAutoEnable": {
    key: "plugin.globalAutoEnable",
    risk: "medium",
    defaultPolicy: "allow",
    allowAutoPolicy: true,
  },
  "secrets.own": {
    key: "secrets.own",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "net.httpDeclared": {
    key: "net.httpDeclared",
    risk: "medium",
    defaultPolicy: "allow",
    allowAutoPolicy: true,
  },
  "net.authProxy": {
    key: "net.authProxy",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "net.loopbackCallback": {
    key: "net.loopbackCallback",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: false,
  },
  "network.localModels": {
    key: "network.localModels",
    risk: "medium",
    defaultPolicy: "allow",
    allowAutoPolicy: true,
  },
  "session.bridgeWrite": {
    key: "session.bridgeWrite",
    risk: "medium",
    defaultPolicy: "ask",
    allowAutoPolicy: true,
  },
  "runtime.highRiskTools": {
    key: "runtime.highRiskTools",
    risk: "medium",
    defaultPolicy: "ask",
    allowAutoPolicy: true,
  },
  "app.scheduler": {
    key: "app.scheduler",
    risk: "medium",
    defaultPolicy: "ask",
    allowAutoPolicy: true,
  },
  "host.installPackages": {
    key: "host.installPackages",
    risk: "high",
    defaultPolicy: "ask",
    allowAutoPolicy: true,
  },
  "exec.localBridge": {
    key: "exec.localBridge",
    risk: "critical",
    defaultPolicy: "deny",
    allowAutoPolicy: false,
  },
};
