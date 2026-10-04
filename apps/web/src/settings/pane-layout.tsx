import type { ReactNode } from "react";

/** Title and one line of context above a pane built from generic widgets. */
export function SettingsPaneHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-5 max-w-2xl space-y-1.5">
      <h2 className="ui-title text-base font-semibold leading-tight">
        {title}
      </h2>
      {description && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </header>
  );
}

/** One setting per row, separated by the theme's rule. */
export function SettingFieldList({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl divide-y divide-(--rule-color) *:py-4 *:first:pt-0 *:last:pb-0">
      {children}
    </div>
  );
}
