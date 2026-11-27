import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils.js";

export function SettingsListSearch({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-w-0 flex-[1_1_12rem] items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary",
        className,
      )}
    >
      <Search
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={label}
        className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label={t("common.clear")}
          onClick={() => onChange("")}
          className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function SettingsListFilter({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="min-h-7 rounded-full border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:font-medium aria-pressed:text-foreground"
    >
      {label}
    </button>
  );
}
