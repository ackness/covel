import type { Context } from "hono";
import { z } from "zod";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { findCommittedInteraction } from "@covel/runtime";
import type { SessionRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import {
  checkHostedOperator,
  sessionApprovalScope,
} from "../session/session-guard.js";

const submissionTargets = z.object({
  turnId: z.string().min(1),
  submissions: z.array(z.object({ interactionId: z.string().min(1) })).min(1),
});

/** Called under the session lock; only persisted form provenance can request code access. */
export async function preflightFormApprovals(
  c: Context,
  session: SessionRecord,
  payload: unknown,
): Promise<Response | undefined> {
  const parsed = submissionTargets.safeParse(payload);
  // The submit-form handler owns input validation and its error messages.
  if (!parsed.success) return;
  const messages = await c.get("store").listTurnMessages(session.id);
  const providers = new Set<string>();
  for (const { interactionId } of parsed.data.submissions) {
    const located = findCommittedInteraction(
      messages,
      parsed.data.turnId,
      interactionId,
    );
    if (!located || located.interaction.validation === undefined) continue;
    const pluginId = located.message.sourcePluginId;
    if (!pluginId) continue;
    if (!session.activePlugins.includes(pluginId))
      return c.json(
        errorBody("Form provider is not active", {
          code: "form_provider_inactive",
        }),
        400,
      );
    providers.add(pluginId);
  }
  const registry = c.get("pluginRegistry");
  const gate = c.get("rpcApprovalGate");
  for (const pluginId of providers) {
    const entry = registry.get(pluginId);
    // Uninstalled providers cannot be restored by granting permission.
    if (!entry)
      return c.json(
        errorBody("Form provider is unavailable", {
          code: "form_provider_unavailable",
        }),
        400,
      );
    const trust = getPluginTrustInfo(pluginId, entry.source);
    if (trust.autoLoad) continue;
    const denied = checkHostedOperator(c);
    if (denied) return denied;
    const scope = sessionApprovalScope(session, pluginId);
    if (
      gate.hasGrant(session.id, pluginId, COMMUNITY_SERVER_CODE_ACTION, scope)
    )
      continue;
    const verdict = gate.evaluate({
      sessionId: session.id,
      sessionScope: scope,
      pluginId,
      action: COMMUNITY_SERVER_CODE_ACTION,
      payload: { operation: "submit-form" },
      trustLevel: trust.source,
      description: `Load form validation for community plugin ${pluginId}`,
    });
    if (verdict.status === "pending")
      return c.json(
        {
          status: "approval-required",
          approvalId: verdict.approvalId,
          pending: verdict.pending,
        },
        202,
      );
    if (verdict.status === "rejected")
      return c.json(
        errorBody("Resolve pending approvals before submitting this form", {
          code: "approval_queue_full",
        }),
        429,
      );
  }
}
