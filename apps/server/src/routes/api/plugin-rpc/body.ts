import type {
  PluginRpcActionRequest,
  PluginRpcRuntimeRequest,
} from "@covel/shared";
import { decodeBase64Json } from "../../../lib/base64-json.js";

export type PluginRpcBody = Partial<PluginRpcActionRequest> &
  Partial<PluginRpcRuntimeRequest>;

export type ValidPluginRpcBody =
  | (PluginRpcActionRequest & {
      readonly runtimeId?: undefined;
      readonly expectsBackgroundFollower?: undefined;
    })
  | (PluginRpcRuntimeRequest & { readonly action?: undefined });

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
  if (!body.pluginId || typeof body.pluginId !== "string") {
    return { ok: false, error: "pluginId (string) is required", status: 400 };
  }
  if (body.action && body.runtimeId) {
    return {
      ok: false,
      error: "action and runtimeId are mutually exclusive",
      status: 400,
    };
  }
  if (!body.action && !body.runtimeId) {
    return {
      ok: false,
      error: "either action or runtimeId is required",
      status: 400,
    };
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

/**
 * Decode the `X-Plugin-User-Settings` request header: base64(json) whose
 * body is `{ [pluginId]: { [settingKey]: value } }`.
 *
 * Malformed input is treated as "no settings" so a single corrupt client
 * request degrades to manifest defaults instead of failing a turn.
 */
export function decodePluginUserSettingsHeader(
  raw: string | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  const json = decodeBase64Json(raw);
  if (!json || typeof json !== "object" || Array.isArray(json))
    return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [pluginId, bucket] of Object.entries(
    json as Record<string, unknown>,
  )) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
      continue;
    out[pluginId] = { ...(bucket as Record<string, unknown>) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
