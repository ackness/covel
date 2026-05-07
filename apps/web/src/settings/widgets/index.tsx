import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import type { SettingEntry, WidgetKind } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { ThemeManagerWidget } from "@/components/theme-manager.js";
import { useSetting } from "../use-settings.js";
import { THEME_MANAGER_WIDGET_KEY } from "@/theme-system/storage.js";

function resolveLabel(
  label: SettingEntry["label"] | undefined,
  locale = "zh-CN",
): string {
  if (!label) return "";
  if (typeof label === "string") return label;
  return label[locale] ?? label["en-US"] ?? Object.values(label)[0] ?? "";
}

function inferWidget(entry: SettingEntry): WidgetKind {
  if (entry.widget) return entry.widget;
  if (entry.backend === "keys" || entry.secret) return "secret";
  if (entry.options) return "select";
  if (typeof entry.default === "boolean") return "toggle";
  if (typeof entry.default === "number") return "number";
  if (typeof entry.default === "string") return "text";
  return "custom";
}

export function SettingWidget({ entry }: { entry: SettingEntry }) {
  const widget = inferWidget(entry);
  switch (widget) {
    case "toggle":
      return <ToggleWidget entry={entry} />;
    case "select":
      return <SelectWidget entry={entry} />;
    case "slider":
      return <SliderWidget entry={entry} />;
    case "number":
      return <NumberWidget entry={entry} />;
    case "secret":
      return <SecretWidget entry={entry} />;
    case "textarea":
      return <TextareaWidget entry={entry} />;
    case "text":
      return <TextWidget entry={entry} />;
    case "custom":
      return <CustomWidgetPlaceholder entry={entry} />;
    case "json":
    default:
      return <JsonWidget entry={entry} />;
  }
}

function FieldShell({
  entry,
  children,
}: {
  entry: SettingEntry;
  children: React.ReactNode;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-widest text-muted-foreground">
        {resolveLabel(entry.label, locale)}
      </Label>
      {entry.description && (
        <p className="text-[11px] text-muted-foreground">
          {resolveLabel(entry.description, locale)}
        </p>
      )}
      {children}
    </div>
  );
}

function TextWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<string>(entry.key);
  return (
    <FieldShell entry={entry}>
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => void setValue(e.target.value)}
        className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
      />
    </FieldShell>
  );
}

function NumberWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<number>(entry.key);
  return (
    <FieldShell entry={entry}>
      <input
        type="number"
        min={entry.min}
        max={entry.max}
        step={entry.step}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") return;
          const n = Number(v);
          if (!Number.isNaN(n)) void setValue(n);
        }}
        className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
      />
    </FieldShell>
  );
}

function ToggleWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<boolean>(entry.key);
  return (
    <FieldShell entry={entry}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => void setValue(!value)}
        className={
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors " +
          (value ? "bg-primary" : "bg-muted")
        }
      >
        <span
          className={
            "inline-block h-4 w-4 rounded-full bg-background transition-transform " +
            (value ? "translate-x-4" : "translate-x-0.5")
          }
        />
      </button>
    </FieldShell>
  );
}

function SelectWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<string>(entry.key);
  const { i18n } = useTranslation();
  return (
    <FieldShell entry={entry}>
      <select
        value={value ?? ""}
        onChange={(e) => void setValue(e.target.value)}
        className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
      >
        {(entry.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {resolveLabel(opt.label, i18n.language)}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function SliderWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<number>(entry.key);
  const min = entry.min ?? 0;
  const max = entry.max ?? 1;
  const step = entry.step ?? 0.1;
  return (
    <FieldShell entry={entry}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          onChange={(e) => void setValue(Number(e.target.value))}
          className="flex-1"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) void setValue(n);
          }}
          className="w-16 bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono text-center"
        />
      </div>
    </FieldShell>
  );
}

function SecretWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<string>(entry.key);
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell entry={entry}>
      <div className="flex gap-1">
        <input
          type={visible ? "text" : "password"}
          value={value ?? ""}
          onChange={(e) => void setValue(e.target.value)}
          placeholder="sk-..."
          className="flex-1 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={() => setVisible((v) => !v)}
          className="shrink-0"
          aria-label={visible ? "Hide" : "Show"}
        >
          {visible ? (
            <EyeOff className="w-3.5 h-3.5" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
    </FieldShell>
  );
}

function TextareaWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<string>(entry.key);
  return (
    <FieldShell entry={entry}>
      <textarea
        value={value ?? ""}
        onChange={(e) => void setValue(e.target.value)}
        rows={4}
        className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
      />
    </FieldShell>
  );
}

function JsonWidget({ entry }: { entry: SettingEntry }) {
  const [value] = useSetting<unknown>(entry.key);
  return (
    <FieldShell entry={entry}>
      <pre className="text-[11px] bg-muted/30 p-2 rounded overflow-auto font-mono max-h-48">
        {JSON.stringify(value, null, 2)}
      </pre>
    </FieldShell>
  );
}

function CustomWidgetPlaceholder({ entry }: { entry: SettingEntry }) {
  if (entry.key === THEME_MANAGER_WIDGET_KEY) {
    return <ThemeManagerWidget />;
  }

  const { t } = useTranslation();
  return (
    <FieldShell entry={entry}>
      <div className="text-xs text-muted-foreground italic border border-dashed border-border p-3">
        {t("settings.customWidgetUnavailable")}
      </div>
    </FieldShell>
  );
}
