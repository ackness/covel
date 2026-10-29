import { describe, expect, it } from "vitest";
import { rpcActionNameSchema } from "../src/schemas/rpc-action.js";
import { pluginManifestSchema } from "../src/schemas/plugin-manifest.js";

describe("RPC action names", () => {
  it.each([
    "runtime:reset",
    "runtime:",
    "covel:plugin-server-code",
    "covel:other",
    "event:reset",
  ])("reserves %s for framework approvals", (action) => {
    expect(rpcActionNameSchema.safeParse(action).success).toBe(false);
    const parsed = pluginManifestSchema.safeParse({
      id: "probe",
      description: "Probe",
      contributes: { actions: [action] },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected an invalid manifest");
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["contributes", "actions", 0],
        message: expect.stringContaining("reserved"),
      }),
    );
  });
  it.each([
    "reset",
    "runtime",
    "event",
    "covel",
    "custom:reset",
    "runtime-reset",
  ])("keeps %s available to ordinary actions", (action) => {
    expect(rpcActionNameSchema.parse(action)).toBe(action);
    expect(
      pluginManifestSchema.safeParse({
        id: "probe",
        description: "Probe",
        contributes: { actions: [action] },
      }).success,
    ).toBe(true);
  });
  it("rejects an empty action", () =>
    expect(rpcActionNameSchema.safeParse("").success).toBe(false));
});
