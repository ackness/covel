import { describe, expect, it } from "vitest";
import { validatePluginRpcBody } from "../../src/routes/api/plugin-rpc/body.js";

describe("plugin-rpc body validation", () => {
  it.each(["runtime:reset", "covel:plugin-server-code", "event:reset"])(
    "rejects the internal approval key %s as a plugin action",
    (action) => {
      expect(
        validatePluginRpcBody({
          kind: "action",
          pluginId: "probe",
          action,
          payload: { reset: true },
        }),
      ).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining("reserved for framework approvals"),
      });
    },
  );

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

  it("accepts an event request and rejects a malformed one", () => {
    expect(
      validatePluginRpcBody({
        kind: "event",
        pluginId: "map",
        topic: "map.location-selected",
        payload: { locationId: "docks" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({ kind: "event", pluginId: "map", topic: "t" }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({ kind: "event", pluginId: "map", topic: "" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      validatePluginRpcBody({
        kind: "event",
        pluginId: "map",
        topic: "t",
        payload: ["docks"],
      }),
    ).toEqual({
      ok: false,
      error: "payload: must be a JSON object",
      status: 400,
    });
    // An event names a topic, never a runtime: the subscribers decide.
    expect(
      validatePluginRpcBody({
        kind: "event",
        pluginId: "map",
        topic: "t",
        runtimeId: "map/travel",
      }),
    ).toEqual({
      ok: false,
      error: "Unknown field(s): runtimeId",
      status: 400,
    });
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
      error: "args: must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody([])).toEqual({
      ok: false,
      error: "body must be a JSON object",
      status: 400,
    });
    expect(validatePluginRpcBody({ pluginId: "p", action: "a" })).toEqual({
      ok: false,
      error: "kind must be one of action, runtime, command, or event",
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
      error: "Unknown field(s): runtimeId",
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
      error: "Unknown field(s): pluginId",
      status: 400,
    });
  });

  it("rejects non-string selectors within each kind", () => {
    expect(
      validatePluginRpcBody({ kind: "action", pluginId: "p", action: 1 }),
    ).toEqual({
      ok: false,
      error: "action: must be a string",
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
      error: "runtimeId: must be a string",
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
      error: "runtimeId: must be a string; Unknown field(s): action",
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
      error: "Unknown field(s): runtimeId",
      status: 400,
    });
  });
  it("preserves arbitrary action/runtime payloads and command/event length boundaries", () => {
    for (const payload of [null, 42, "text", ["item"], { nested: true }]) {
      expect(
        validatePluginRpcBody({
          kind: "action",
          pluginId: "p",
          action: "a",
          payload,
        }),
      ).toMatchObject({ ok: true, body: { payload } });
      expect(
        validatePluginRpcBody({
          kind: "runtime",
          pluginId: "p",
          runtimeId: "p/r",
          payload,
        }),
      ).toMatchObject({ ok: true, body: { payload } });
    }
    const command = { kind: "command", commandId: "p:c" };
    for (const length of [1, 10_000]) {
      expect(
        validatePluginRpcBody({ ...command, input: "x".repeat(length) }),
      ).toMatchObject({ ok: true });
    }
    expect(
      validatePluginRpcBody({ ...command, args: { text: "x".repeat(9_989) } }),
    ).toMatchObject({ ok: true });
    expect(
      validatePluginRpcBody({
        kind: "event",
        pluginId: "p",
        topic: "x".repeat(128),
        payload: {},
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    { kind: "command", commandId: "p:c" },
    { kind: "command", commandId: "p:c", input: "" },
    { kind: "command", commandId: "p:c", input: "x".repeat(10_001) },
    { kind: "command", commandId: "p:c", args: { text: "x".repeat(9_990) } },
    { kind: "command", commandId: "p:c", args: null },
    { kind: "action", pluginId: "", action: "a" },
    { kind: "action", pluginId: "p", action: "" },
    { kind: "action", pluginId: "p", action: "a", input: "text" },
    {
      kind: "action",
      pluginId: "p",
      action: "a",
      expectsBackgroundFollower: true,
    },
    { kind: "runtime", pluginId: "p", runtimeId: "" },
    { kind: "runtime", pluginId: "p", runtimeId: "p/r", retryFromTurnId: "" },
    { kind: "runtime", pluginId: "p", runtimeId: "p/r", args: {} },
    { kind: "event", pluginId: "p", topic: "x".repeat(129) },
    { kind: "event", pluginId: "p", topic: "t", payload: null },
  ])("rejects invalid fields and lengths (case %#)", (body) => {
    expect(validatePluginRpcBody(body)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
