import { useTranslation } from "react-i18next";

export interface ReasoningDisclosureEntry {
  id: string;
  content: string;
  label?: string;
}

/** Native disclosure stays collapsed by default, including after history restore. */
export function ReasoningDisclosure({
  entries,
}: {
  entries: readonly ReasoningDisclosureEntry[];
}) {
  const { t } = useTranslation();
  const visible = entries.filter((entry) => entry.content.trim());
  if (!visible.length) return null;
  return (
    <details
      className="min-w-0 border border-border/60 bg-muted/10 text-xs"
      data-testid="reasoning-disclosure"
    >
      <summary className="cursor-pointer px-3 py-2 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-primary">
        {t("session.reasoningContent")} · {visible.length}
      </summary>
      <div className="max-h-80 space-y-4 overflow-y-auto border-t border-border/60 p-3">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("session.reasoningContentHint")}
        </p>
        {visible.map((entry, index) => (
          <section key={entry.id} className="min-w-0 space-y-1.5">
            <div className="font-medium text-muted-foreground">
              {entry.label ? `${entry.label} · ` : ""}
              {index + 1}
            </div>
            <pre className="whitespace-pre-wrap wrap-anywhere font-sans text-xs leading-relaxed text-foreground select-text">
              {entry.content}
            </pre>
          </section>
        ))}
      </div>
    </details>
  );
}
