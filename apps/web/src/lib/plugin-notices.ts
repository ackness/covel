import type { TFunction } from "i18next";
import {
  isDependencyRejection,
  providedContracts,
  type PluginResolutionRejection,
  type PluginSummary,
} from "@covel/shared";
import { resolveDisplayText } from "./i18n-text.js";

type NoticePlugin = Pick<
  PluginSummary,
  "id" | "displayName" | "provides" | "extensions" | "runtimes"
>;

/** The plugin's display name in the UI language, else its ID. */
export function pluginName(
  plugins: readonly NoticePlugin[],
  pluginId: string,
): string {
  const plugin = plugins.find((item) => item.id === pluginId);
  return (plugin && resolveDisplayText(plugin.displayName)) || pluginId;
}

/** Installed plugins that provide a contract. */
export function contractProviders<T extends NoticePlugin>(
  plugins: readonly T[],
  contract: string,
): T[] {
  return plugins.filter((plugin) =>
    providedContracts({
      provides: plugin.provides,
      extensions: plugin.extensions,
    }).includes(contract),
  );
}

/**
 * Why a plugin is off, in words for the player: for a missing dependency,
 * which contract it waits for and which installed plugin would provide it.
 */
export function pluginOffReason(
  t: TFunction,
  item: PluginResolutionRejection,
  plugins: readonly NoticePlugin[],
): string {
  const plugin = pluginName(plugins, item.pluginId);
  if (isDependencyRejection(item)) {
    const providers = contractProviders(plugins, item.contract)
      .filter((provider) => provider.id !== item.pluginId)
      .map((provider) => pluginName(plugins, provider.id));
    return providers.length > 0
      ? t("plugin.off.needsProvider", {
          plugin,
          contract: item.contract,
          providers: providers.join(", "),
        })
      : t("plugin.off.noProvider", { plugin, contract: item.contract });
  }
  switch (item.code) {
    case "unknown-plugin":
      return t("plugin.off.notInstalled", { plugin });
    case "conflict":
    case "single-provider-conflict":
    case "event-topic-conflict":
      return t("plugin.off.conflict", { plugin });
    default:
      return t("plugin.off.other", { plugin });
  }
}

/** Plugins with a runtime that tells the story (`io.visibility: story`). */
export function storyPlugins<T extends NoticePlugin>(
  plugins: readonly T[],
): T[] {
  return plugins.filter((plugin) =>
    plugin.runtimes.some((runtime) => runtime.outputKind === "story"),
  );
}
