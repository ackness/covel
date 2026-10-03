import { useTranslation } from "react-i18next";
import { openLlmToml } from "@/lib/desktop-bridge.js";
import { emitToast } from "@/lib/toast-channel.js";
import { reloadLlmConfig } from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";

/**
 * Open the active llm.toml from a Settings button. A first open creates the
 * file from the built-in default, so the running configuration is reloaded to
 * make Settings report the file as its source.
 */
export function useOpenLlmToml(): () => Promise<void> {
  const { t } = useTranslation();
  const { boot } = useSession();
  return async () => {
    let created: boolean;
    try {
      ({ created } = await openLlmToml());
    } catch (error) {
      emitToast(
        "error",
        t("settings.llmTomlOpenFailed"),
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (!created) return;
    emitToast("success", t("settings.llmTomlCreated"));
    try {
      await reloadLlmConfig();
      await boot();
    } catch {
      // request() already surfaced a transport/HTTP toast.
    }
  };
}
