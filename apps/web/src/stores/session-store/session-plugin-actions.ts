import i18n from "i18next";
import type { PluginMutationResponse, SessionPlugin } from "@covel/shared";
import * as api from "@/services/api";
import { confirmPluginApproval } from "@/lib/approval-message.js";
import { requestChoices, requestConfirm } from "@/lib/confirm-channel.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  SessionWorkspaceSyncError,
  type SessionWorkspace,
} from "@/services/data-service.js";
import { refreshSessionActionKinds } from "./action-kinds-refresh.js";
import type { MutableRef } from "./runtime-refs.js";
import { reportWorkspaceSyncError } from "./runtime-rpc.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import type { SessionDispatch } from "./types.js";

/** The session a plugin action belongs to; stale results are dropped. */
export interface SessionPluginActionOptions {
  dispatch: SessionDispatch;
  workspace: SessionWorkspace;
  sessionIdRef: MutableRef<string | null>;
  sessionGenerationRef: MutableRef<number>;
}

/** Reload the session's plugin list and action-kind catalogue. */
export async function loadSessionPlugins({
  dispatch,
  sessionIdRef,
  sessionGenerationRef,
}: Omit<SessionPluginActionOptions, "workspace">): Promise<void> {
  const sid = sessionIdRef.current;
  if (!sid) return;
  const generation = sessionGenerationRef.current;
  const isCurrent = () =>
    sessionIdRef.current === sid && sessionGenerationRef.current === generation;
  // The catalogue follows the plugin list: the same activations decide
  // both. Each read stands alone, so one failing leaves the other.
  await Promise.all([
    refreshSessionResource(dispatch, ["plugins", sid], {
      isCurrent,
      read: () => api.listSessionPlugins(sid),
      apply: (res) =>
        dispatch({
          type: "LOAD_SESSION_PLUGINS",
          plugins: [...res.items],
          commands: [...res.commands],
          unavailable: res.unavailable,
        }),
    }).catch(() => {
      // Non-critical: plugins panel is optional.
    }),
    refreshSessionActionKinds(dispatch, sid, isCurrent),
  ]);
}

/** Enable or disable one session plugin, asking for approval when needed. */
export async function toggleSessionPlugin(
  pluginId: string,
  enable: boolean,
  {
    dispatch,
    workspace,
    sessionIdRef,
    sessionGenerationRef,
  }: SessionPluginActionOptions,
): Promise<void> {
  const sid = sessionIdRef.current;
  if (!sid) return;
  const generation = sessionGenerationRef.current;
  const isCurrent = () =>
    sessionIdRef.current === sid && sessionGenerationRef.current === generation;
  // UI specs are fetched when active plugins change. Publish that change
  // only after the server mutation, so panels cannot cache the old specs.
  const applyActive = () => {
    if (isCurrent()) {
      dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, active: enable });
    }
  };
  const applyWorldData = (result: PluginMutationResponse) => {
    if (isCurrent() && result.worldData)
      dispatch({
        type: "SET_WORLD_DATA_NOTICES",
        notices: result.worldData.notices,
      });
  };
  try {
    if (!enable) {
      await workspace.run(
        sid,
        `plugin-disable:${crypto.randomUUID()}`,
        async () => {
          const result = await api.disableSessionPlugin(sid, pluginId);
          applyActive();
          return result;
        },
      );
      return;
    }

    const firstResult = await workspace.run(
      sid,
      `plugin-enable:${crypto.randomUUID()}`,
      async () => {
        const result = await api.enableSessionPlugin(sid, pluginId);
        if (!("status" in result)) {
          applyActive();
          applyWorldData(result);
        }
        return result;
      },
    );
    if (!("status" in firstResult)) return;
    if (firstResult.status !== "approval-required") {
      throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
    }

    // The confirmation dialog must not hold the session workspace FIFO;
    // background checkpoints and other actions remain free to settle while
    // the player decides.
    const approved =
      isCurrent() &&
      (await confirmPluginApproval(firstResult.pending, {
        t: (key, options) => i18n.t(key, options) as string,
        confirm: requestConfirm,
      }));
    if (!approved || !isCurrent()) {
      await workspace.run(sid, `plugin-deny:${crypto.randomUUID()}`, () =>
        api.resolveApproval(firstResult.approvalId, "deny", "session", sid),
      );
      return;
    }

    await workspace.run(
      sid,
      `plugin-approve:${crypto.randomUUID()}`,
      async () => {
        // Navigation may happen while this job waits for the workspace.
        if (!isCurrent()) {
          await api.resolveApproval(
            firstResult.approvalId,
            "deny",
            "session",
            sid,
          );
          return;
        }
        await api.resolveApproval(
          firstResult.approvalId,
          "allow",
          "session",
          sid,
        );
        const enabled = await api.enableSessionPlugin(sid, pluginId);
        if ("status" in enabled) {
          throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
        }
        applyActive();
        applyWorldData(enabled);
      },
    );
  } catch (error) {
    if (!isCurrent()) return;
    if (
      error instanceof SessionWorkspaceSyncError &&
      error.stage === "checkpoint"
    ) {
      reportWorkspaceSyncError(error, dispatch);
      return;
    }
    reportWorkspaceSyncError(error, dispatch);
  }
}

/**
 * Authorize several paused community plugins with one prompt that names each
 * of them, instead of one prompt per plugin. Every plugin still gets its own
 * approval request and its own grant; only the question is asked once.
 *
 * The prompt comes first and the approval requests after it, one plugin at a
 * time. Enabling a plugin makes the server drop the pending approvals of the
 * session's other paused plugins, so requests gathered up front would be
 * gone by the time the second one is answered. Asking first also leaves no
 * request behind for a plugin the player unticked.
 */
export async function approveSessionPlugins(
  plugins: readonly SessionPlugin[],
  {
    dispatch,
    workspace,
    sessionIdRef,
    sessionGenerationRef,
  }: SessionPluginActionOptions,
): Promise<void> {
  const sid = sessionIdRef.current;
  if (!sid || plugins.length === 0) return;
  const generation = sessionGenerationRef.current;
  const isCurrent = () =>
    sessionIdRef.current === sid && sessionGenerationRef.current === generation;

  const allowed = await requestChoices({
    title: i18n.t("plugin.approval.batchTitle"),
    message: i18n.t("plugin.approval.batchMessage"),
    confirmLabel: i18n.t("plugin.approval.allowSelected"),
    cancelLabel: i18n.t("plugin.approval.notNow"),
    choices: plugins.map((plugin) => {
      const label =
        resolveDisplayText(plugin.displayName, i18n.language) || plugin.id;
      return {
        id: plugin.id,
        label,
        detail: [
          // The id is the label already when the plugin has no name.
          [label === plugin.id ? "" : plugin.id, plugin.version]
            .filter(Boolean)
            .join(" · "),
          resolveDisplayText(plugin.description, i18n.language),
        ]
          .filter(Boolean)
          .join(" — "),
      };
    }),
  });

  for (const plugin of plugins) {
    if (!allowed.includes(plugin.id)) continue;
    try {
      await workspace.run(
        sid,
        `plugin-approve:${crypto.randomUUID()}`,
        async () => {
          // Navigation may happen while this job waits for the workspace.
          if (!isCurrent()) return;
          const activate = (result: PluginMutationResponse) => {
            if (!isCurrent()) return;
            dispatch({
              type: "TOGGLE_SESSION_PLUGIN",
              pluginId: plugin.id,
              active: true,
            });
            if (result.worldData)
              dispatch({
                type: "SET_WORLD_DATA_NOTICES",
                notices: result.worldData.notices,
              });
          };
          const first = await api.enableSessionPlugin(sid, plugin.id);
          if (!("status" in first)) return activate(first);
          if (first.status !== "approval-required")
            throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
          // The player consented to this plugin by name. A request about
          // anything else is refused rather than granted under it.
          if (first.pending.pluginId !== plugin.id || !isCurrent()) {
            await api.resolveApproval(first.approvalId, "deny", "session", sid);
            return;
          }
          await api.resolveApproval(first.approvalId, "allow", "session", sid);
          const enabled = await api.enableSessionPlugin(sid, plugin.id);
          if ("status" in enabled)
            throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
          activate(enabled);
        },
      );
    } catch (error) {
      // One plugin failing must not stop the others the player allowed.
      if (isCurrent()) reportWorkspaceSyncError(error, dispatch);
    }
  }
}
