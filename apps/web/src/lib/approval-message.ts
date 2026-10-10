type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The grant for letting a community plugin's server code run. */
const SERVER_CODE_ACTION = "covel:plugin-server-code";
const RUNTIME_ACTION_PREFIX = "runtime:";

/**
 * The text of the single-approval dialog. Internal action identifiers are
 * explained in plain words; an action without a known form keeps the generic
 * wording.
 */
export function approvalConfirmMessage(
  t: Translate,
  pluginId: string,
  action: string,
): string {
  if (action === SERVER_CODE_ACTION)
    return t("plugin.approval.serverCodeMessage", {
      pluginId,
      defaultValue:
        "Plugin {{pluginId}} is a community plugin. Authorizing it lets its code run inside the Covel backend, without a process sandbox, until the backend restarts.",
    });
  if (action.startsWith(RUNTIME_ACTION_PREFIX))
    return t("plugin.approval.runtimeMessage", {
      pluginId,
      runtime: action.slice(RUNTIME_ACTION_PREFIX.length),
      defaultValue:
        "Plugin {{pluginId}} asks to run its task {{runtime}} in this session. Authorize it?",
    });
  return t("plugin.approval.confirmMessage", {
    pluginId,
    action,
    defaultValue:
      "Plugin {{pluginId}} requests permission to run {{action}}. Authorize all matching calls for this session?",
  });
}
