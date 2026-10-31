import {
  sessionBridgeRequests,
  type SessionBridgeCapability,
  type SessionBridgeOutcome,
  type PluginRpcResponse,
} from "@covel/shared";
import type { SessionActions } from "@/stores/session-store/context.js";
import type { SessionState } from "@/stores/session-store/types.js";
import { isPendingInteractionMessage } from "./game-view/interaction-blocks.js";
import { publicInteraction } from "./session-bridge-interactions.js";
import type { createInteractionHandles } from "./session-bridge-interactions.js";

type Dependencies = {
  pluginId: string;
  capabilities: readonly SessionBridgeCapability[];
  isCurrent(): boolean;
  read(): SessionState;
  handles: ReturnType<typeof createInteractionHandles>;
  actions: Pick<
    SessionActions,
    "submitComposerAction" | "submitInteraction" | "abortActiveTurn"
  >;
  invokeRuntime(
    runtimeId: string,
    payload: unknown,
    isCurrent: () => boolean,
  ): Promise<PluginRpcResponse | null>;
  ownPanels(): readonly string[] | Promise<readonly string[]>;
  openPanel(panelId: string): void;
};
const unavailable = (): SessionBridgeOutcome => ({
  status: "unavailable",
  code: "stale",
});

/** Only public settlement facts, never a nested RPC output or error string. */
export function runtimeBridgeOutcome(
  response: PluginRpcResponse | null,
  pluginId: string,
  runtimeId: string,
): SessionBridgeOutcome {
  if (response?.status === "accepted") return { status: "accepted" };
  if (response?.status !== "ok" || response.abortReason)
    return { status: "rejected", code: "runtime-refused" };
  const target = response.runtimeResults?.find(
    (item) => item.pluginId === pluginId && item.runtimeId === runtimeId,
  );
  // The normal sync runtime route only returns ok after successful commit.
  if (
    !target ||
    target.status !== "success" ||
    target.error ||
    response.runtimeResults?.some((item) => item.status === "failed")
  )
    return { status: "rejected", code: "runtime-refused" };
  return { status: "committed" };
}

export function createSessionBridgeActions(deps: Dependencies) {
  const active = () => deps.isCurrent();
  const target = (runtimeId: string) =>
    deps
      .read()
      .sessionPlugins.find(
        (plugin) =>
          plugin.id === deps.pluginId &&
          plugin.active &&
          !plugin.approvalRequired &&
          !plugin.paused,
      )
      ?.runtimes.find(
        (runtime) =>
          runtime.id === runtimeId &&
          !runtime.subagentOnly &&
          runtime.trigger.type === "manual",
      );
  const run = async (
    method: SessionBridgeCapability,
    params: Record<string, unknown>,
  ): Promise<SessionBridgeOutcome> => {
    if (!active()) return unavailable();
    if (!deps.capabilities.includes(method))
      return { status: "rejected", code: "permission-denied" };
    const parsed = sessionBridgeRequests[method].safeParse(params);
    if (!parsed.success) return { status: "rejected", code: "invalid-request" };
    const state = deps.read();
    try {
      switch (method) {
        case "submitAction": {
          const request = sessionBridgeRequests.submitAction.parse(params);
          const seat = request.seatId
            ? state.session?.seats.find((item) => item.id === request.seatId)
            : state.session?.seats.find(
                (item) => item.controller === "human" && item.role === "player",
              );
          const allowed = state.sessionActionKinds?.seats.find(
            (item) =>
              item.seatId === seat?.id &&
              item.controller === "human" &&
              item.role === seat?.role,
          )?.allowed;
          if (
            !seat ||
            seat.controller !== "human" ||
            !allowed?.includes(request.kind)
          )
            return { status: "rejected", code: "invalid-request" };
          if (
            state.session?.phase !== "playing" ||
            state.suspensions.length > 0 ||
            state.messages.some((message) =>
              isPendingInteractionMessage(
                message,
                state.messages,
                state.submittedBlockIds,
              ),
            )
          )
            return { status: "unavailable", code: "busy" };
          if (!active()) return unavailable();
          return deps.actions.submitComposerAction(request, {
            isCurrent: active,
          })
            ? { status: "accepted" }
            : { status: "unavailable", code: "busy" };
        }
        case "submitInteraction": {
          const { handle, values } =
            sessionBridgeRequests.submitInteraction.parse(params);
          const ref = deps.handles.resolve(
            handle,
            state.messages,
            state.submittedBlockIds,
          );
          if (!ref || !active()) return unavailable();
          const result = await deps.actions.submitInteraction(
            ref.blockId,
            ref.turnId,
            ref.interactionId,
            ref.type,
            values,
            {
              isCurrent: () =>
                active() &&
                Boolean(
                  deps.handles.resolve(
                    handle,
                    deps.read().messages,
                    deps.read().submittedBlockIds,
                  ),
                ),
            },
          );
          if (!active()) return unavailable();
          const message = state.messages.find(
            (item) => item.id === ref.blockId,
          );
          const display = message?.block
            ? publicInteraction(message.block)
            : undefined;
          const publicNames = new Set(
            display?.type === "form"
              ? display.fields.map((field) => field.name)
              : [],
          );
          if (result?.rejected.length)
            return {
              status: "rejected",
              code: "field-invalid",
              issues: result.rejected.slice(0, 32).map((issue) => ({
                ...(issue.field && publicNames.has(issue.field)
                  ? { field: issue.field }
                  : {}),
                code: "invalid" as const,
              })),
            };
          if (
            result?.status === "accepted" ||
            result?.status === "already-answered"
          ) {
            deps.handles.consume(handle);
            return result.status === "accepted"
              ? { status: "accepted" }
              : { status: "unavailable", code: "already-answered" };
          }
          return unavailable();
        }
        case "invokeRuntime": {
          const { runtimeId, payload } =
            sessionBridgeRequests.invokeRuntime.parse(params);
          if (!target(runtimeId)) return unavailable();
          const isCurrent = () => active() && Boolean(target(runtimeId));
          const result = await deps.invokeRuntime(
            runtimeId,
            payload,
            isCurrent,
          );
          return isCurrent()
            ? runtimeBridgeOutcome(result, deps.pluginId, runtimeId)
            : unavailable();
        }
        case "abortExecution":
          if (!active()) return unavailable();
          await deps.actions.abortActiveTurn();
          return active() ? { status: "accepted" } : unavailable();
        case "openPanel": {
          const { panelId } = sessionBridgeRequests.openPanel.parse(params);
          if (!(await deps.ownPanels()).includes(panelId) || !active())
            return unavailable();
          deps.openPanel(panelId);
          return { status: "accepted" };
        }
      }
    } catch {
      return { status: "rejected", code: "failed" };
    }
  };
  return Object.fromEntries(
    Object.keys(sessionBridgeRequests).map((method) => [
      method,
      (params: Record<string, unknown>) =>
        run(method as SessionBridgeCapability, params),
    ]),
  );
}
