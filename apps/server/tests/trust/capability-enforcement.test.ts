import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  type CapabilityKey,
} from "@covel/shared/permissions";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

/**
 * Canonical production enforcement sites for every non-reserved capability in
 * `CAPABILITY_KEYS`. Adding a new capability without either wiring a real
 * enforcement site here or explicitly marking it `reserved: true` fails this
 * test so no paper-only capability toggles can drift into the UI or catalog.
 */
const ENFORCEMENT_SITES: Readonly<
  Record<Exclude<CapabilityKey, "exec.localBridge">, readonly string[]>
> = {
  "plugin.declarative": [
    "apps/server/src/trust/plugin-admission.ts",
    "apps/server/src/trust/permission-service.ts",
  ],
  "compute.sandboxWorker": [
    "apps/server/src/routes/api/bootstrap/plugin-entry-api.ts",
  ],
  "plugin.communityCode": [
    "apps/server/src/trust/permission-service.ts",
    "apps/server/src/routes/api/session/plugins.ts",
    "apps/server/src/host-profile.ts",
  ],
  "plugin.instanceScope": [
    "apps/server/src/routes/api/bootstrap/instance-plugins.ts",
    "apps/server/src/routes/api/bootstrap/plugin-entry-api.ts",
  ],
  "plugin.providerSource": [
    "apps/server/src/routes/api/bootstrap/provider-sources.ts",
  ],
  "channel.bridge": ["apps/server/src/routes/api/bootstrap/plugin-host.ts"],
  "plugin.globalAutoEnable": ["apps/server/src/routes/api/session/plugins.ts"],
  "secrets.own": ["apps/server/src/routes/api/bootstrap/plugin-entry-api.ts"],
  "net.httpDeclared": [
    "apps/server/src/routes/api/bootstrap/plugin-entry-api.ts",
    "apps/server/src/routes/api/turn-execution-deps.ts",
    "apps/server/src/routes/api/bootstrap/runtime-jobs.ts",
    "packages/runtime/src/function-runtime/http-permissions.ts",
  ],
  "net.authProxy": ["apps/server/src/routes/api/bootstrap/plugin-entry-api.ts"],
  "net.loopbackCallback": ["apps/server/src/routes/api/plugin-flows.ts"],
  "network.localModels": [
    "apps/server/src/host-profile.ts",
    "apps/server/src/routes/api/bootstrap/provider-sources.ts",
    "apps/server/src/routes/api/bootstrap/plugin-entry-api.ts",
  ],
  "session.bridgeWrite": [
    "apps/server/src/routes/api/plugin-rpc/action-dispatch.ts",
    "apps/server/src/routes/api/plugin-rpc/event-dispatch.ts",
    "apps/server/src/routes/api/plugin-rpc.ts",
    "apps/server/src/routes/api/plugin-data.ts",
  ],
  "runtime.highRiskTools": ["apps/server/src/routes/api/bootstrap/tools.ts"],
  "app.scheduler": ["apps/server/src/routes/api/bootstrap/app-scheduler.ts"],
  "host.installPackages": ["apps/server/src/host-profile.ts"],
};

describe("capability enforcement registry", () => {
  it("maps every non-reserved CAPABILITY_KEYS entry to real production enforcement code", async () => {
    const reservedKeys = CAPABILITY_KEYS.filter(
      (key) => CAPABILITY_CATALOG[key].reserved === true,
    );
    expect(reservedKeys).toEqual(["exec.localBridge"]);

    for (const key of CAPABILITY_KEYS) {
      const def = CAPABILITY_CATALOG[key];
      if (def.reserved) {
        expect(def.defaultPolicy).toBe("deny");
        expect(def.allowAutoPolicy).toBe(false);
        continue;
      }

      const sites = ENFORCEMENT_SITES[key as keyof typeof ENFORCEMENT_SITES];
      expect(
        sites?.length ?? 0,
        `Capability "${key}" must declare at least one production enforcement site`,
      ).toBeGreaterThan(0);

      for (const relPath of sites) {
        const content = await readFile(path.join(REPO_ROOT, relPath), "utf8");
        expect(
          content,
          `Expected "${key}" enforcement reference in ${relPath}`,
        ).toContain(`"${key}"`);
      }
    }
  });
});
