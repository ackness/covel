import { fileURLToPath } from "node:url";
import { readMessageCatalogs } from "@covel/plugin-loader";
import type { PluginMessages } from "@covel/plugin-handlers-utils";
import { pluginMessagesFor } from "@covel/shared";

/**
 * The `ctx.messages` a session in `locale` gets for a plugin: its
 * `locales/<locale>.yaml` translations, as the host builds them. A handler
 * test that checks translated text passes this in its context.
 *
 * ```js
 * const messages = await loadPluginMessages(new URL("..", import.meta.url), "zh-CN");
 * await handler({ locale: "zh-CN", messages });
 * ```
 */
export async function loadPluginMessages(
  pluginRoot: string | URL,
  locale: string,
): Promise<PluginMessages | undefined> {
  const root =
    typeof pluginRoot === "string" ? pluginRoot : fileURLToPath(pluginRoot);
  return pluginMessagesFor(await readMessageCatalogs(root), locale);
}
