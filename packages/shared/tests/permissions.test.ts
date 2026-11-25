import { describe, expect, it } from "vitest";
import {
  describeServerSetting,
  pluginCapabilitiesSchema,
} from "../src/index.js";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  DEFAULT_PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_SERVER_SETTING,
  capabilityCeilingSchema,
  capabilityKeySchema,
  capabilityPolicyModeSchema,
  evaluatePluginGrantValidity,
  isCapabilityKey,
  permissionsPolicyFromEnv,
  permissionsPolicySchema,
  pluginGrantDecisionFor,
  pluginGrantDecisionsSchema,
  pluginGrantRecordSchema,
  resolveEffectiveCapability,
  resolvePermissionsPolicy,
  tightenCapabilityCeiling,
  type CapabilityCeiling,
} from "../src/permissions/index.js";

describe("permission capability catalog", () => {
  it("defines catalog metadata for every capability key", () => {
    expect(CAPABILITY_KEYS).toHaveLength(17);
    expect(Object.keys(CAPABILITY_CATALOG)).toEqual([...CAPABILITY_KEYS]);
    for (const key of CAPABILITY_KEYS) {
      const def = CAPABILITY_CATALOG[key];
      expect(def.key).toBe(key);
      expect(capabilityKeySchema.parse(key)).toBe(key);
      expect(capabilityPolicyModeSchema.parse(def.defaultPolicy)).toBe(
        def.defaultPolicy,
      );
      if (def.risk === "critical") {
        expect(def.defaultPolicy).toBe("deny");
        expect(def.allowAutoPolicy).toBe(false);
      }
    }
  });

  it("validates capability keys and rejects unknown names", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(isCapabilityKey(key)).toBe(true);
    }
    for (const invalid of ["", "plugin.unknown", "PLUGIN.COMMUNITYCODE"]) {
      expect(isCapabilityKey(invalid)).toBe(false);
    }
    expect(capabilityCeilingSchema.options).toEqual([
      "enabled",
      "operator-only",
      "disabled",
    ]);
  });
});

describe("tightenCapabilityCeiling", () => {
  const ordered: CapabilityCeiling[] = ["disabled", "operator-only", "enabled"];

  it("narrows ceilings monotonically downward and never widens", () => {
    for (const [i, base] of ordered.entries()) {
      for (const [j, requested] of ordered.entries()) {
        const expected = ordered[Math.min(i, j)];
        expect(tightenCapabilityCeiling(base, requested)).toBe(expected);
      }
    }
  });
});

describe("resolveEffectiveCapability", () => {
  it("denies disabled ceilings regardless of policy, grant, or operator", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "disabled",
        policy: "allow",
        grant: "allow",
        isOperator: true,
      }),
    ).toEqual({
      ceiling: "disabled",
      policy: "allow",
      effective: "deny",
      lockedBy: "ceiling",
    });
  });

  it("denies operator-only ceilings when the caller is not an operator", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "operator-only",
        policy: "allow",
        grant: "allow",
        isOperator: false,
      }),
    ).toEqual({
      ceiling: "operator-only",
      policy: "allow",
      effective: "deny",
      lockedBy: "ceiling",
    });

    expect(
      resolveEffectiveCapability({
        ceiling: "operator-only",
        policy: "ask",
        grant: "allow",
        isOperator: true,
      }),
    ).toEqual({
      ceiling: "operator-only",
      policy: "ask",
      effective: "allow",
    });
  });

  it("denies when policy is deny even if a grant allows it", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "enabled",
        policy: "deny",
        grant: "allow",
        isOperator: true,
      }),
    ).toEqual({
      ceiling: "enabled",
      policy: "deny",
      effective: "deny",
      lockedBy: "policy",
    });
  });

  it("denies when grant is deny even when policy allows", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "enabled",
        policy: "allow",
        grant: "deny",
      }),
    ).toEqual({
      ceiling: "enabled",
      policy: "allow",
      effective: "deny",
      lockedBy: "grant",
    });
  });

  it("resolves ask policy based on grant decision", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "enabled",
        policy: "ask",
      }),
    ).toEqual({
      ceiling: "enabled",
      policy: "ask",
      effective: "ask",
    });

    expect(
      resolveEffectiveCapability({
        ceiling: "enabled",
        policy: "ask",
        grant: "allow",
      }),
    ).toEqual({
      ceiling: "enabled",
      policy: "ask",
      effective: "allow",
    });
  });

  it("allows when ceiling is enabled, policy is allow, and grant is unset or allow", () => {
    expect(
      resolveEffectiveCapability({
        ceiling: "enabled",
        policy: "allow",
        grant: "unset",
      }),
    ).toEqual({
      ceiling: "enabled",
      policy: "allow",
      effective: "allow",
    });
  });
});

describe("permissionsPolicySchema and server setting", () => {
  it("normalizes overrides, drops default-matching entries, and orders canonically", () => {
    const parsed = permissionsPolicySchema.parse({
      "app.scheduler": "deny",
      "plugin.declarative": "allow", // matches catalog default -> omitted
      "net.httpDeclared": "deny",
      "compute.sandboxWorker": "allow", // allowAutoPolicy: true -> allowed
    });
    expect(parsed).toEqual({
      "compute.sandboxWorker": "allow",
      "net.httpDeclared": "deny",
      "app.scheduler": "deny",
    });
    expect(Object.keys(parsed)).toEqual([
      "compute.sandboxWorker",
      "net.httpDeclared",
      "app.scheduler",
    ]);
  });

  it("rejects unknown capability keys and allow on auto-policy-forbidden capabilities", () => {
    expect(
      permissionsPolicySchema.safeParse({ "unknown.cap": "deny" }).success,
    ).toBe(false);
    for (const key of CAPABILITY_KEYS) {
      if (!CAPABILITY_CATALOG[key].allowAutoPolicy) {
        expect(
          permissionsPolicySchema.safeParse({ [key]: "allow" }).success,
          `${key} should reject allow`,
        ).toBe(false);
        expect(
          permissionsPolicySchema.safeParse({ [key]: "deny" }).success,
          `${key} should allow deny`,
        ).toBe(true);
      }
      if (CAPABILITY_CATALOG[key].reserved) {
        expect(
          permissionsPolicySchema.safeParse({ [key]: "ask" }).success,
          `${key} reserved capability should reject non-default ask`,
        ).toBe(false);
        expect(
          pluginGrantDecisionsSchema.safeParse({ [key]: "allow" }).success,
          `${key} reserved capability should reject plugin grant allow`,
        ).toBe(false);
        expect(
          pluginGrantDecisionsSchema.safeParse({ [key]: "deny" }).success,
          `${key} reserved capability should reject plugin grant deny`,
        ).toBe(false);
      }
    }
    expect(CAPABILITY_CATALOG["exec.localBridge"].reserved).toBe(true);
  });

  it("parses COVEL_PERMISSIONS_POLICY env overrides and resolves precedence", () => {
    expect(permissionsPolicyFromEnv({})).toBeUndefined();
    expect(
      permissionsPolicyFromEnv({ COVEL_PERMISSIONS_POLICY: " , " }),
    ).toBeUndefined();
    expect(
      permissionsPolicyFromEnv({
        COVEL_PERMISSIONS_POLICY: "plugin.communityCode=allow",
      }),
    ).toBeUndefined();
    expect(
      permissionsPolicyFromEnv({ COVEL_PERMISSIONS_POLICY: "bad-pair" }),
    ).toBeUndefined();
    expect(
      permissionsPolicyFromEnv({
        COVEL_PERMISSIONS_POLICY:
          " plugin.communityCode=deny , compute.sandboxWorker=allow ",
      }),
    ).toEqual({
      "compute.sandboxWorker": "allow",
      "plugin.communityCode": "deny",
    });

    const info = describeServerSetting(
      PERMISSIONS_POLICY_SERVER_SETTING,
      { "net.httpDeclared": "deny" },
      true,
      { COVEL_PERMISSIONS_POLICY: "plugin.declarative=deny" },
    );
    expect(info).toEqual({
      value: { "plugin.declarative": "deny" },
      source: "env",
      settable: false,
    });

    const resolved = resolvePermissionsPolicy({ "net.httpDeclared": "deny" });
    expect(resolved["net.httpDeclared"]).toBe("deny");
    expect(resolved["plugin.declarative"]).toBe(
      DEFAULT_PERMISSIONS_POLICY["plugin.declarative"],
    );
  });
});

describe("plugin persistent grants", () => {
  const emptyCaps = pluginCapabilitiesSchema.parse({
    serverCode: true,
    http: [],
    hooks: [],
    tools: ["dice"],
    actions: [],
    services: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  });

  const sampleGrant = pluginGrantRecordSchema.parse({
    pluginId: "demo-plugin",
    version: "1.0.0",
    contentDigest: "sha256:aaa",
    grantedCapabilities: emptyCaps,
    decisions: {
      "net.httpDeclared": "allow",
      "plugin.communityCode": "allow",
      "secrets.own": "deny",
    },
    grantedAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  });

  it("orders grant decisions canonically and validates grant records", () => {
    expect(Object.keys(sampleGrant.decisions)).toEqual([
      "plugin.communityCode",
      "secrets.own",
      "net.httpDeclared",
    ]);
    expect(
      pluginGrantDecisionsSchema.safeParse({ "bad.key": "allow" }).success,
    ).toBe(false);
  });

  it("invalidates allow on stale digest or capability escalation while keeping deny sticky", () => {
    expect(
      evaluatePluginGrantValidity({
        grant: undefined,
        currentDigest: "sha256:aaa",
        currentCapabilities: emptyCaps,
      }),
    ).toBe("none");

    expect(
      evaluatePluginGrantValidity({
        grant: sampleGrant,
        currentDigest: undefined,
        currentCapabilities: emptyCaps,
      }),
    ).toBe("unreadable");

    expect(
      evaluatePluginGrantValidity({
        grant: sampleGrant,
        currentDigest: "sha256:aaa",
        currentCapabilities: emptyCaps,
      }),
    ).toBe("valid");
    expect(
      pluginGrantDecisionFor("valid", sampleGrant, "plugin.communityCode"),
    ).toBe("allow");
    expect(pluginGrantDecisionFor("valid", sampleGrant, "secrets.own")).toBe(
      "deny",
    );
    expect(pluginGrantDecisionFor("valid", sampleGrant, "app.scheduler")).toBe(
      "unset",
    );

    const staleStatus = evaluatePluginGrantValidity({
      grant: sampleGrant,
      currentDigest: "sha256:bbb",
      currentCapabilities: emptyCaps,
    });
    expect(staleStatus).toBe("stale-digest");
    expect(
      pluginGrantDecisionFor(staleStatus, sampleGrant, "plugin.communityCode"),
    ).toBe("unset");
    expect(
      pluginGrantDecisionFor(staleStatus, sampleGrant, "secrets.own"),
    ).toBe("deny");

    const escalatedCaps = pluginCapabilitiesSchema.parse({
      ...emptyCaps,
      tools: ["dice", "extra"],
    });
    const escalatedStatus = evaluatePluginGrantValidity({
      grant: sampleGrant,
      currentDigest: "sha256:aaa",
      currentCapabilities: escalatedCaps,
    });
    expect(escalatedStatus).toBe("capability-escalated");
    expect(
      pluginGrantDecisionFor(
        escalatedStatus,
        sampleGrant,
        "plugin.communityCode",
      ),
    ).toBe("unset");
    expect(
      pluginGrantDecisionFor(escalatedStatus, sampleGrant, "secrets.own"),
    ).toBe("deny");
  });
});
