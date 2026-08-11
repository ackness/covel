/**
 * Runtime contract for POST /api/actions.
 *
 * Parse the untrusted body into a discriminated union before the route reads a
 * session or creates a turn. Each action owns an explicit payload shape so
 * unused or misspelled fields fail closed instead of silently changing the
 * meaning of a request.
 */
interface ActionRequestBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly locale?: string;
  readonly model?: string;
}

export type ActionRequest =
  | (ActionRequestBase & {
      readonly type: "send_message";
      readonly payload: { readonly content: string };
    })
  | (ActionRequestBase & {
      readonly type: "execute_command";
      readonly payload: { readonly command: string };
    })
  | (ActionRequestBase & {
      readonly type: "start_session";
      readonly payload: { readonly loreOverride?: string };
    })
  | (ActionRequestBase & {
      readonly type: "retry_runtime";
      readonly payload: {
        readonly runtimeId?: string;
        readonly retryFromTurnId?: string;
      };
    });

export type ActionRequestValidation =
  | { readonly ok: true; readonly value: ActionRequest }
  | { readonly ok: false; readonly error: string };

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key));
}

function validateString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return `${field} must be a non-empty string`;
  }
  if (value.length > maxLength) {
    return `${field} must be at most ${maxLength} characters`;
  }
  if (pattern && !pattern.test(value)) {
    return `${field} has an invalid format`;
  }
  return undefined;
}

function validateOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  return value === undefined
    ? undefined
    : validateString(value, field, maxLength, pattern);
}

function validateOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return `${field} must be a string`;
  return value.length > maxLength
    ? `${field} must be at most ${maxLength} characters`
    : undefined;
}

function validateOptionalModel(value: unknown): string | undefined {
  const error = validateOptionalString(value, "model", 256);
  if (error || value === undefined) return error;

  for (const character of value as string) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return "model has an invalid format";
    }
  }
  return undefined;
}

export function validateActionRequest(raw: unknown): ActionRequestValidation {
  if (!isPlainRecord(raw)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const unknownTopLevel = hasOnlyKeys(raw, [
    "requestId",
    "type",
    "sessionId",
    "locale",
    "model",
    "payload",
  ]);
  if (unknownTopLevel) {
    return {
      ok: false,
      error: `Unknown action request field: ${unknownTopLevel}`,
    };
  }
  const commonError =
    validateString(raw.requestId, "requestId", 128, ACTION_ID_PATTERN) ??
    validateString(raw.sessionId, "sessionId", 256, ACTION_ID_PATTERN) ??
    validateOptionalString(raw.locale, "locale", 64, LOCALE_PATTERN) ??
    validateOptionalModel(raw.model);
  if (commonError) return { ok: false, error: commonError };

  const base = {
    requestId: raw.requestId as string,
    sessionId: raw.sessionId as string,
    ...(raw.locale !== undefined ? { locale: raw.locale as string } : {}),
    ...(raw.model !== undefined ? { model: raw.model as string } : {}),
  };
  const payload = raw.payload ?? {};
  if (!isPlainRecord(payload)) {
    return { ok: false, error: "payload must be a JSON object" };
  }

  switch (raw.type) {
    case "send_message": {
      const unknown = hasOnlyKeys(payload, ["content"]);
      const error =
        (unknown ? `Unknown send_message payload field: ${unknown}` : null) ??
        validateString(payload.content, "send_message.content", 100_000);
      return error
        ? { ok: false, error }
        : {
            ok: true,
            value: {
              ...base,
              type: "send_message",
              payload: { content: payload.content as string },
            },
          };
    }
    case "execute_command": {
      const unknown = hasOnlyKeys(payload, ["command"]);
      const error =
        (unknown
          ? `Unknown execute_command payload field: ${unknown}`
          : null) ??
        validateString(payload.command, "execute_command.command", 10_000);
      return error
        ? { ok: false, error }
        : {
            ok: true,
            value: {
              ...base,
              type: "execute_command",
              payload: { command: payload.command as string },
            },
          };
    }
    case "start_session": {
      const unknown = hasOnlyKeys(payload, ["loreOverride"]);
      const error = unknown
        ? `Unknown start_session payload field: ${unknown}`
        : validateOptionalText(
            payload.loreOverride,
            "start_session.loreOverride",
            500_000,
          );
      return error
        ? { ok: false, error }
        : {
            ok: true,
            value: {
              ...base,
              type: "start_session",
              payload:
                payload.loreOverride !== undefined
                  ? { loreOverride: payload.loreOverride as string }
                  : {},
            },
          };
    }
    case "retry_runtime": {
      const unknown = hasOnlyKeys(payload, ["runtimeId", "retryFromTurnId"]);
      const error =
        (unknown ? `Unknown retry_runtime payload field: ${unknown}` : null) ??
        validateOptionalString(
          payload.runtimeId,
          "retry_runtime.runtimeId",
          200,
          ACTION_ID_PATTERN,
        ) ??
        validateOptionalString(
          payload.retryFromTurnId,
          "retry_runtime.retryFromTurnId",
          256,
          ACTION_ID_PATTERN,
        ) ??
        (payload.retryFromTurnId !== undefined &&
        payload.runtimeId === undefined
          ? "retry_runtime.retryFromTurnId requires runtimeId"
          : undefined);
      return error
        ? { ok: false, error }
        : {
            ok: true,
            value: {
              ...base,
              type: "retry_runtime",
              payload: {
                ...(payload.runtimeId !== undefined
                  ? { runtimeId: payload.runtimeId as string }
                  : {}),
                ...(payload.retryFromTurnId !== undefined
                  ? { retryFromTurnId: payload.retryFromTurnId as string }
                  : {}),
              },
            },
          };
    }
    default:
      return {
        ok: false,
        error: `Unsupported action type: ${String(raw.type)}`,
      };
  }
}
