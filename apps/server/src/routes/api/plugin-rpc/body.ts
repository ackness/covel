import type { PluginRpcRequest } from "@covel/shared";

export type PluginRpcBodyValidation =
  | { readonly ok: true; readonly body: PluginRpcRequest }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: 400;
    };

function rejectUnknownFields(
  body: Readonly<Record<string, unknown>>,
  kind: PluginRpcRequest["kind"],
  allowed: readonly string[],
): PluginRpcBodyValidation | undefined {
  const allowedSet = new Set(allowed);
  const fields = Object.keys(body).filter((field) => !allowedSet.has(field));
  if (fields.length === 0) return undefined;
  return {
    ok: false,
    error: `kind "${kind}" does not accept field(s): ${fields.join(", ")}`,
    status: 400,
  };
}

export function validatePluginRpcBody(raw: unknown): PluginRpcBodyValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object", status: 400 };
  }

  const body = raw as Record<string, unknown>;
  if (
    body.kind !== "action" &&
    body.kind !== "runtime" &&
    body.kind !== "command"
  ) {
    return {
      ok: false,
      error: "kind must be one of action, runtime, or command",
      status: 400,
    };
  }

  if (body.kind === "command") {
    if (body.action !== undefined || body.runtimeId !== undefined) {
      return {
        ok: false,
        error: 'kind "command" does not accept action or runtimeId',
        status: 400,
      };
    }
    if (typeof body.commandId !== "string" || body.commandId.length === 0) {
      return { ok: false, error: "commandId must be a string", status: 400 };
    }
    const hasInput = body.input !== undefined;
    const hasArgs = body.args !== undefined;
    if (hasInput === hasArgs) {
      return {
        ok: false,
        error: "command dispatch requires exactly one of input or args",
        status: 400,
      };
    }
    if (
      hasInput &&
      (typeof body.input !== "string" ||
        body.input.length === 0 ||
        body.input.length > 10_000)
    ) {
      return {
        ok: false,
        error: "input must be a non-empty string of at most 10000 characters",
        status: 400,
      };
    }
    if (hasArgs) {
      if (
        !body.args ||
        typeof body.args !== "object" ||
        Array.isArray(body.args)
      ) {
        return { ok: false, error: "args must be a JSON object", status: 400 };
      }
      if (JSON.stringify(body.args).length > 10_000) {
        return {
          ok: false,
          error: "args must be at most 10000 JSON characters",
          status: 400,
        };
      }
    }
    if (
      body.pluginId !== undefined ||
      body.payload !== undefined ||
      body.expectsBackgroundFollower !== undefined ||
      body.retryFromTurnId !== undefined
    ) {
      return {
        ok: false,
        error:
          "command dispatch does not accept pluginId, payload, expectsBackgroundFollower, or retryFromTurnId",
        status: 400,
      };
    }
    const unknown = rejectUnknownFields(body, body.kind, [
      "kind",
      "commandId",
      "input",
      "args",
    ]);
    if (unknown) return unknown;
    return { ok: true, body: body as unknown as PluginRpcRequest };
  }

  if (body.kind === "action") {
    if (body.runtimeId !== undefined || body.commandId !== undefined) {
      return {
        ok: false,
        error: 'kind "action" does not accept runtimeId or commandId',
        status: 400,
      };
    }
    if (body.input !== undefined || body.args !== undefined) {
      return {
        ok: false,
        error: "input and args require kind command",
        status: 400,
      };
    }
    if (
      body.expectsBackgroundFollower !== undefined ||
      body.retryFromTurnId !== undefined
    ) {
      return {
        ok: false,
        error:
          "action dispatch does not accept expectsBackgroundFollower or retryFromTurnId",
        status: 400,
      };
    }
    if (!body.pluginId || typeof body.pluginId !== "string") {
      return { ok: false, error: "pluginId (string) is required", status: 400 };
    }
    if (typeof body.action !== "string") {
      return { ok: false, error: "action must be a string", status: 400 };
    }
    if (body.action.length === 0) {
      return {
        ok: false,
        error: "action must be a non-empty string",
        status: 400,
      };
    }
    const unknown = rejectUnknownFields(body, body.kind, [
      "kind",
      "pluginId",
      "action",
      "payload",
    ]);
    if (unknown) return unknown;
    return { ok: true, body: body as unknown as PluginRpcRequest };
  }

  if (body.action !== undefined || body.commandId !== undefined) {
    return {
      ok: false,
      error: 'kind "runtime" does not accept action or commandId',
      status: 400,
    };
  }
  if (body.input !== undefined || body.args !== undefined) {
    return {
      ok: false,
      error: "input and args require kind command",
      status: 400,
    };
  }
  if (!body.pluginId || typeof body.pluginId !== "string") {
    return { ok: false, error: "pluginId (string) is required", status: 400 };
  }
  if (typeof body.runtimeId !== "string") {
    return { ok: false, error: "runtimeId must be a string", status: 400 };
  }
  if (body.runtimeId.length === 0) {
    return {
      ok: false,
      error: "runtimeId must be a non-empty string",
      status: 400,
    };
  }
  if (
    body.expectsBackgroundFollower !== undefined &&
    typeof body.expectsBackgroundFollower !== "boolean"
  ) {
    return {
      ok: false,
      error: "expectsBackgroundFollower must be a boolean",
      status: 400,
    };
  }
  if (
    body.retryFromTurnId !== undefined &&
    (typeof body.retryFromTurnId !== "string" || body.retryFromTurnId === "")
  ) {
    return {
      ok: false,
      error: "retryFromTurnId must be a non-empty string",
      status: 400,
    };
  }
  const unknown = rejectUnknownFields(body, body.kind, [
    "kind",
    "pluginId",
    "runtimeId",
    "payload",
    "expectsBackgroundFollower",
    "retryFromTurnId",
  ]);
  if (unknown) return unknown;
  return { ok: true, body: body as unknown as PluginRpcRequest };
}
