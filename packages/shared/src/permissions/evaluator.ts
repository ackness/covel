import type {
  CapabilityCeiling,
  CapabilityGrantDecision,
  CapabilityPolicyMode,
} from "./catalog.js";

const CEILING_RANK: Readonly<Record<CapabilityCeiling, number>> = {
  disabled: 0,
  "operator-only": 1,
  enabled: 2,
};

/**
 * Narrow a deployment capability ceiling monotonically downward.
 * A stricter upper ceiling (`disabled` < `operator-only` < `enabled`) can never
 * be widened by a later override.
 */
export function tightenCapabilityCeiling(
  base: CapabilityCeiling,
  requested: CapabilityCeiling,
): CapabilityCeiling {
  return CEILING_RANK[requested] < CEILING_RANK[base] ? requested : base;
}

export interface EffectiveCapabilityState {
  readonly ceiling: CapabilityCeiling;
  readonly policy: CapabilityPolicyMode;
  readonly effective: CapabilityPolicyMode;
  readonly lockedBy?: "ceiling" | "policy" | "grant";
}

/**
 * Resolve the effective decision for a capability from L1 ceiling, L2 instance
 * policy, and optional L3/L4 grant decision. Lower layers can only restrict or
 * satisfy an `"ask"` policy, never bypass a `"disabled"` ceiling or `"deny"`.
 */
export function resolveEffectiveCapability(input: {
  readonly ceiling: CapabilityCeiling;
  readonly policy: CapabilityPolicyMode;
  readonly grant?: CapabilityGrantDecision;
  readonly isOperator?: boolean;
}): EffectiveCapabilityState {
  const { ceiling, policy, grant = "unset", isOperator = false } = input;
  if (ceiling === "disabled") {
    return { ceiling, policy, effective: "deny", lockedBy: "ceiling" };
  }
  if (ceiling === "operator-only" && !isOperator) {
    return { ceiling, policy, effective: "deny", lockedBy: "ceiling" };
  }
  if (policy === "deny") {
    return { ceiling, policy, effective: "deny", lockedBy: "policy" };
  }
  if (grant === "deny") {
    return { ceiling, policy, effective: "deny", lockedBy: "grant" };
  }
  if (policy === "ask") {
    return {
      ceiling,
      policy,
      effective: grant === "allow" ? "allow" : "ask",
    };
  }
  return { ceiling, policy, effective: "allow" };
}
