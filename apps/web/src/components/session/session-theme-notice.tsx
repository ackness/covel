import { useTranslation } from "react-i18next";
import { usePluginThemeSessionState } from "@/theme-system/use-plugin-theme.js";
import type { PluginThemeSession } from "@/theme-system/plugin-themes.js";
import { useNotice } from "@/lib/notice-center.js";

/**
 * A card when this game's theme could not be loaded or saved, with the way
 * back to the default look. A theme that works needs no bar: the reset lives
 * in the header's theme menu.
 */
export function SessionThemeNotice({
  theme,
  sessionId,
}: {
  theme?: PluginThemeSession;
  sessionId: string;
}): null {
  const { t } = useTranslation();
  const state = usePluginThemeSessionState(theme);
  const error = state?.error;
  useNotice(
    error
      ? {
          key: "session-theme",
          kind: "card",
          tone: "warning",
          scope: sessionId,
          title: t("session.theme.noticeTitle"),
          body: t(
            error === "off-save"
              ? "session.theme.offSaveFailed"
              : error === "resource"
                ? "session.theme.loadFailed"
                : "settings.saveFailed",
          ),
          actions: [
            {
              label: t("session.theme.default"),
              onClick: () => void theme?.select(null),
            },
          ],
        }
      : null,
  );
  return null;
}
