import type {
  PluginRpcActionRequest,
  PluginRpcCommandRequest,
  PluginRpcRuntimeRequest,
} from "@covel/shared";

export type PluginRpcBody = Partial<PluginRpcActionRequest> &
  Partial<PluginRpcRuntimeRequest> &
  Partial<PluginRpcCommandRequest>;

export type ValidPluginRpcBody =
  | (PluginRpcActionRequest & {
      readonly runtimeId?: undefined;
      readonly expectsBackgroundFollower?: undefined;
      readonly commandId?: undefined;
      readonly input?: undefined;
      readonly args?: undefined;
    })
  | (PluginRpcRuntimeRequest & {
      readonly action?: undefined;
      readonly commandId?: undefined;
      readonly input?: undefined;
      readonly args?: undefined;
    })
  | (PluginRpcCommandRequest & {
      readonly pluginId?: undefined;
      readonly action?: undefined;
      readonly runtimeId?: undefined;
      readonly payload?: undefined;
      readonly expectsBackgroundFollower?: undefined;
      readonly retryFromTurnId?: undefined;
    });

export type PluginRpcBodyValidation =
  | { readonly ok: true; readonly body: ValidPluginRpcBody }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: 400;
    };

export function validatePluginRpcBody(raw: unknown): PluginRpcBodyValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object", status: 400 };
  }

  const body = raw as Record<string, unknown>;
  const selectors = [body.action, body.runtimeId, body.commandId].filter(
    (value) => value !== undefined,
  );
  if (selectors.length > 1) {
    return {
      ok: false,
      error: "action, runtimeId, and commandId are mutually exclusive",
      status: 400,
    };
  }
  if (selectors.length === 0) {
    return {
      ok: false,
      error: "one of action, runtimeId, or commandId is required",
      status: 400,
    };
  }
  if (body.commandId !== undefined) {
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
    if (body.pluginId !== undefined || body.payload !== undefined) {
      return {
        ok: false,
        error: "command dispatch does not accept pluginId or payload",
        status: 400,
      };
    }
    return { ok: true, body: body as unknown as ValidPluginRpcBody };
  }
  if (body.input !== undefined || body.args !== undefined) {
    return {
      ok: false,
      error: "input and args require commandId",
      status: 400,
    };
  }
  if (!body.pluginId || typeof body.pluginId !== "string") {
    return { ok: false, error: "pluginId (string) is required", status: 400 };
  }
  if (body.action !== undefined && typeof body.action !== "string") {
    return { ok: false, error: "action must be a string", status: 400 };
  }
  if (body.runtimeId !== undefined && typeof body.runtimeId !== "string") {
    return { ok: false, error: "runtimeId must be a string", status: 400 };
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
  if (body.retryFromTurnId !== undefined && !body.runtimeId) {
    return {
      ok: false,
      error: "retryFromTurnId requires runtimeId",
      status: 400,
    };
  }

  return { ok: true, body: body as unknown as ValidPluginRpcBody };
}
