import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import {
  isServerManagedSecret,
  type SettingEntry,
  type WidgetKind,
} from "@covel/settings";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  resolveSettingEntryText,
  resolveSettingOptionText,
} from "../framework-i18n.js";
import { useSetting } from "../use-settings.js";

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
  controlId,
  children,
}: {
  entry: SettingEntry;
  controlId?: string;
  children: React.ReactNode;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <div className="space-y-1.5">
      <Label
        id={settingLabelId(entry.key)}
        htmlFor={controlId}
        className="text-xs uppercase tracking-widest text-muted-foreground"
      >
        {resolveSettingEntryText(entry, "label", locale)}
      </Label>
      {entry.description && (
        <p className="text-[11px] text-muted-foreground">
          {resolveSettingEntryText(entry, "description", locale)}
        </p>
      )}
      {children}
    </div>
  );
}

function settingControlId(key: string, suffix?: string): string {
  return `setting-${key}${suffix ? `-${suffix}` : ""}`;
}

function settingLabelId(key: string): string {
  return `${settingControlId(key)}-label`;
}

function TextWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useSetting<string>(entry.key);
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <input
        id={controlId}
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
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <input
        id={controlId}
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
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <button
        id={controlId}
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
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <select
        id={controlId}
        value={value ?? ""}
        onChange={(e) => void setValue(e.target.value)}
        className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
      >
        {(entry.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {resolveSettingOptionText(entry, opt, i18n.language)}
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
  const rangeId = settingControlId(entry.key);
  const numberId = settingControlId(entry.key, "number");
  return (
    <FieldShell entry={entry} controlId={rangeId}>
      <div className="flex items-center gap-2">
        <input
          id={rangeId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          onChange={(e) => void setValue(Number(e.target.value))}
          className="flex-1"
        />
        <input
          id={numberId}
          aria-labelledby={settingLabelId(entry.key)}
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
  const { t } = useTranslation();
  const [value, setValue] = useSetting<string>(entry.key);
  const [visible, setVisible] = useState(false);
  const serverManaged = isServerManagedSecret(value);
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <div className="flex gap-1">
        <input
          id={controlId}
          type={visible ? "text" : "password"}
          value={serverManaged ? "" : (value ?? "")}
          onChange={(e) => void setValue(e.target.value)}
          placeholder={
            serverManaged
              ? t(
                  "settings.serverManagedKeyPlaceholder",
                  "Configured on this device; enter a value to replace",
                )
              : "sk-..."
          }
          className="flex-1 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
        />
        {serverManaged && (
          <Button
            variant="outline"
            onClick={() => void setValue("")}
            className="shrink-0"
          >
            {t("settings.clear", "Clear")}
          </Button>
        )}
        <Button
          variant="outline"
          size="icon"
          onClick={() => setVisible((v) => !v)}
          className="shrink-0"
          aria-label={
            visible ? t("settings.hide", "Hide") : t("settings.show", "Show")
          }
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
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <textarea
        id={controlId}
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
  // The theme-library widget used to be dispatched here. It now renders inside
  // the Appearance pane, which also filters `ui.themeManager` out of the nav —
  // so this branch had become unreachable.
  const { t } = useTranslation();
  return (
    <FieldShell entry={entry}>
      <div className="text-xs text-muted-foreground italic border border-dashed border-border p-3">
        {t("settings.customWidgetUnavailable")}
      </div>
    </FieldShell>
  );
}
