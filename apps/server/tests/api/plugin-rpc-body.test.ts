import { describe, expect, it } from "vitest";
import { validatePluginRpcBody } from "../../src/routes/api/plugin-rpc/body.js";

describe("plugin-rpc body validation", () => {
  it("accepts action and runtime requests", () => {
    expect(
      validatePluginRpcBody({ pluginId: "codex", action: "submit" }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({
        pluginId: "image",
        runtimeId: "image/generate",
        expectsBackgroundFollower: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed request shapes", () => {
    expect(validatePluginRpcBody(null)).toEqual({
      ok: false,
      error: "body must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody([])).toEqual({
      ok: false,
      error: "body must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody({ pluginId: "p" })).toEqual({
      ok: false,
      error: "either action or runtimeId is required",
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        pluginId: "p",
        action: "a",
        runtimeId: "r",
      }),
    ).toEqual({
      ok: false,
      error: "action and runtimeId are mutually exclusive",
      status: 400,
    });
  });

  it("rejects non-string discriminators", () => {
    expect(validatePluginRpcBody({ pluginId: "p", action: 1 })).toEqual({
      ok: false,
      error: "action must be a string",
      status: 400,
    });
    expect(validatePluginRpcBody({ pluginId: "p", runtimeId: true })).toEqual({
      ok: false,
      error: "runtimeId must be a string",
      status: 400,
    });
  });
});
