import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Title and one line of context above a pane built from generic widgets. */
export function SettingsPaneHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-workspace-heading mb-4">
      <div className="min-w-0">
        <h2 className="wrap-break-word text-xl font-semibold tracking-tight @lg:text-2xl">
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions}
    </header>
  );
}

/** One setting per row, separated by the theme's rule. */
export function SettingFieldList({ children }: { children: ReactNode }) {
  return <div className="ui-field-rows max-w-3xl">{children}</div>;
}

export function SettingsHelp({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <details className="text-xs leading-relaxed text-muted-foreground">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <Info aria-hidden="true" className="size-3.5 shrink-0" />
        {label ?? t("settings.parameterHelp")}
      </summary>
      <div className="mt-2 max-w-prose">{children}</div>
    </details>
  );
}
