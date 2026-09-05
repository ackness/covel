import type { Context } from "hono";
import { errorBody } from "../../../api-error.js";
import {
  hasOperatorToken,
  isSessionOwnerAuthEnforced,
  OPERATOR_TOKEN_REQUIRED_CODE,
} from "../session/session-guard.js";

/** Global world writes require an operator whenever sessions are isolated. */
export function checkWorldWriteAccess(c: Context): Response | undefined {
  if (!isSessionOwnerAuthEnforced(c) || hasOperatorToken(c)) return undefined;
  return c.json(
    errorBody("Operator token required to modify shared worlds", {
      code: OPERATOR_TOKEN_REQUIRED_CODE,
    }),
    401,
  );
}
