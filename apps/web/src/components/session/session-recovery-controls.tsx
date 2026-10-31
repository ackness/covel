import { usePluginThemeSessionState } from "@/theme-system/use-plugin-theme.js";
import { useTranslation } from "react-i18next";
import type { PluginThemeSession } from "@/theme-system/plugin-themes.js";
import { Button } from "@/components/ui/button.js";

/** Host chrome, outside decorative planes, narrative parts and page frames. */
export function SessionRecoveryControls({
  theme,
}: {
  theme?: PluginThemeSession;
}) {
  const { t } = useTranslation();
  const state = usePluginThemeSessionState(theme);
  if (!state?.effective && !state?.error && !state?.saving && !state?.selected)
    return null;
  return (
    <div
      data-testid="session-recovery-controls"
      // Above story/plugin views (z-1), below the header's menus (z-20).
      className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-1.5 text-xs"
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => void theme?.select(null)}
      >
        {t("session.theme.default")}
      </Button>
      {state?.error && (
        <span role="alert">
          {t(
            state.error === "off-save"
              ? "session.theme.offSaveFailed"
              : state.error === "resource"
                ? "session.theme.loadFailed"
                : "settings.saveFailed",
          )}
        </span>
      )}
    </div>
  );
}
