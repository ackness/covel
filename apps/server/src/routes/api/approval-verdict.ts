import type { Context } from "hono";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type EvaluateResult,
  type RpcApprovalGate,
} from "@covel/approval";
import type { SessionRecord } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { sessionApprovalScope } from "./session/session-guard.js";

export function hasServerCodeGrant(
  gate: RpcApprovalGate,
  session: SessionRecord,
  pluginId: string,
): boolean {
  return gate.hasGrant(
    session.id,
    pluginId,
    COMMUNITY_SERVER_CODE_ACTION,
    sessionApprovalScope(session, pluginId),
  );
}

/** Keep each caller's rejection message/code while sharing the wire envelope. */
export function approvalVerdictResponse(
  c: Context,
  verdict: EvaluateResult,
  rejected: {
    readonly message: string | ((limit: number) => string);
    readonly code: string;
  },
): Response | undefined {
  if (verdict.status === "denied") {
    const code =
      verdict.reason === "ceiling"
        ? "capability_disabled"
        : verdict.reason === "policy"
          ? "capability_denied_by_policy"
          : "capability_denied_by_grant";
    const subject = verdict.capability
      ? `Capability "${verdict.capability}"`
      : "Operation";
    const reasonText =
      verdict.reason === "ceiling"
        ? "is disabled on this host"
        : verdict.reason === "policy"
          ? "is denied by instance policy"
          : "is denied by persistent plugin grant";
    return c.json(errorBody(`${subject} ${reasonText}`, { code }), 403);
  }
  if (verdict.status === "pending") {
    return c.json(
      {
        status: "approval-required",
        approvalId: verdict.approvalId,
        pending: verdict.pending,
      },
      202,
    );
  }
  if (verdict.status === "rejected") {
    const message =
      typeof rejected.message === "string"
        ? rejected.message
        : rejected.message(verdict.limit);
    return c.json(errorBody(message, { code: rejected.code }), 429);
  }
}
