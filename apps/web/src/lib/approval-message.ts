import type { I18nText } from "@covel/shared";
import { resolveDisplayText } from "./i18n-text.js";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Display names of the installed plugins, kept by the session provider. An
 * approval can be asked from several places (a turn, a panel, a toggle), and
 * each names the plugin by ID only.
 */
let pluginNames: ReadonlyMap<string, I18nText> = new Map();

export function setApprovalPluginNames(
  plugins: readonly { readonly id: string; readonly displayName: I18nText }[],
): void {
  pluginNames = new Map(
    plugins.map((plugin) => [plugin.id, plugin.displayName]),
  );
}

/** The plugin's display name in the interface language, else its ID. */
export function approvalPluginName(pluginId: string): string {
  return resolveDisplayText(pluginNames.get(pluginId)) || pluginId;
}

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
  const plugin = approvalPluginName(pluginId);
  if (action === SERVER_CODE_ACTION)
    return t("plugin.approval.serverCodeMessage", {
      plugin,
      defaultValue:
        '"{{plugin}}" is a community plugin. If you allow it, its code runs inside the Covel backend, without a process sandbox, until the backend restarts.',
    });
  if (action.startsWith(RUNTIME_ACTION_PREFIX))
    return t("plugin.approval.runtimeMessage", {
      plugin,
      runtime: action.slice(RUNTIME_ACTION_PREFIX.length),
      defaultValue:
        '"{{plugin}}" asks to run its task {{runtime}} in this game. Allow it?',
    });
  return t("plugin.approval.confirmMessage", {
    plugin,
    action,
    defaultValue:
      '"{{plugin}}" asks to run {{action}}. Allow all such requests in this game?',
  });
}
