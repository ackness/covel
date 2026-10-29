import i18n from "i18next";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { emitToast } from "@/lib/toast-channel.js";
import * as api from "@/services/api.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import type { SessionAction, SessionState } from "./types.js";
import type { MutableRef } from "./runtime-refs.js";

// The action and subscription channels can both carry the same transition.
const notices = new WeakMap<MutableRef<SessionState>, Map<string, string>>();
export function handlePluginFaultNotice(
  deps: {
    dispatch: (action: SessionAction) => void;
    stateRef: MutableRef<SessionState>;
    sessionIdRef: MutableRef<string | null>;
  },
  type: "plugin.fault.latched" | "plugin.fault.cleared",
  payload: Readonly<Record<string, unknown>>,
  turnId = "",
): void {
  const sessionId = deps.sessionIdRef.current;
  if (!sessionId || typeof payload.pluginId !== "string") return;
  const key = `${sessionId}\0${payload.pluginId}`;
  let seen = notices.get(deps.stateRef);
  if (!seen) notices.set(deps.stateRef, (seen = new Map()));
  if (type === "plugin.fault.cleared") seen.delete(key);
  else if (seen.get(key) !== turnId) {
    seen.set(key, turnId);
    const plugin = deps.stateRef.current.sessionPlugins.find(
      (item) => item.id === payload.pluginId,
    );
    const label = plugin
      ? resolveI18n(plugin.displayName, i18n.language)
      : undefined;
    emitToast(
      "info",
      i18n.t("plugin.faultPausedNotice", { plugin: label || payload.pluginId }),
    );
  }
  void refreshSessionResource(deps.dispatch, ["plugins", sessionId], {
    isCurrent: () => deps.sessionIdRef.current === sessionId,
    read: () => api.listSessionPlugins(sessionId),
    apply: (res) =>
      deps.dispatch({
        type: "LOAD_SESSION_PLUGINS",
        plugins: [...res.items],
        commands: [...res.commands],
        unavailable: res.unavailable,
      }),
  }).catch(() => {
    /* The next list refresh can retry this read. */
  });
}
