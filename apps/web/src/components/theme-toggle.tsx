import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  getThemeDefinition,
  THEME_SCHEME_KEY,
} from "@/theme-system/registry.js";
import type { ThemeScheme } from "@/theme-system/types.js";
import { useSetting } from "@/settings/use-settings.js";

export function ThemeToggle() {
  const [appearance] = useSetting<string>("ui.appearance");
  const [scheme, setScheme] = useSetting<ThemeScheme>(THEME_SCHEME_KEY);
  const { t } = useTranslation();
  const nextScheme = scheme === "light" ? "dark" : "light";
  const theme = getThemeDefinition(appearance);
  const canToggle = theme ? theme.schemes.includes(nextScheme) : true;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9 text-muted-foreground hover:text-primary hover:bg-muted/40 rounded-(--radius-control)"
      disabled={!canToggle}
      aria-disabled={!canToggle}
      onClick={() => {
        if (!canToggle) return;
        void setScheme(nextScheme);
      }}
    >
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">{t("common.toggleTheme", "Toggle theme")}</span>
    </Button>
  );
}
