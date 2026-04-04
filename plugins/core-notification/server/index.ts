import type { PluginRegistrar } from "@covel/plugin-runtime";
import { emitNotificationTool } from "./tools.js";
import { notificationContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("emit-notification", emitNotificationTool);

  registrar.addContextProvider(
    "notification-context",
    notificationContextProvider,
  );
}
