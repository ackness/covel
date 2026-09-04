import { describe, expect, it } from "vitest";
import { validatePluginRpcBody } from "../../src/routes/api/plugin-rpc/body.js";

describe("plugin-rpc body validation", () => {
  it("accepts action, runtime, and command requests", () => {
    expect(
      validatePluginRpcBody({
        kind: "action",
        pluginId: "codex",
        action: "submit",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        input: "/roll 2d6",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        args: { notation: "2d6" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({
        kind: "runtime",
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
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        input: "/roll",
        args: {},
      }),
    ).toEqual({
      ok: false,
      error: "command dispatch requires exactly one of input or args",
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        args: [],
      }),
    ).toEqual({
      ok: false,
      error: "args must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody([])).toEqual({
      ok: false,
      error: "body must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody({ pluginId: "p", action: "a" })).toEqual({
      ok: false,
      error: "kind must be one of action, runtime, or command",
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        kind: "action",
        pluginId: "p",
        action: "a",
        runtimeId: "r",
      }),
    ).toEqual({
      ok: false,
      error: 'kind "action" does not accept runtimeId or commandId',
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        input: "/roll",
        pluginId: "dice-check",
      }),
    ).toEqual({
      ok: false,
      error:
        "command dispatch does not accept pluginId, payload, expectsBackgroundFollower, or retryFromTurnId",
      status: 400,
    });
  });

  it("rejects non-string selectors within each kind", () => {
    expect(
      validatePluginRpcBody({ kind: "action", pluginId: "p", action: 1 }),
    ).toEqual({
      ok: false,
      error: "action must be a string",
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        kind: "runtime",
        pluginId: "p",
        runtimeId: true,
      }),
    ).toEqual({
      ok: false,
      error: "runtimeId must be a string",
      status: 400,
    });
  });

  it("rejects unknown fields and invalid runtime flags", () => {
    expect(
      validatePluginRpcBody({
        kind: "action",
        pluginId: "p",
        action: "run",
        admin: true,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      validatePluginRpcBody({
        kind: "runtime",
        pluginId: "p",
        runtimeId: "p/run",
        expectsBackgroundFollower: "yes",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("uses kind as the only invocation discriminator", () => {
    expect(
      validatePluginRpcBody({
        kind: "runtime",
        pluginId: "p",
        action: "a",
      }),
    ).toEqual({
      ok: false,
      error: 'kind "runtime" does not accept action or commandId',
      status: 400,
    });
    expect(
      validatePluginRpcBody({
        kind: "command",
        commandId: "dice-check:roll",
        runtimeId: "dice-check/roll",
        input: "/roll",
      }),
    ).toEqual({
      ok: false,
      error: 'kind "command" does not accept action or runtimeId',
      status: 400,
    });
  });
});
