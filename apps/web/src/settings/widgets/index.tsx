import { createContext, useContext, useEffect, useRef, useState } from "react";
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
import { useSetting, useSettingOverride } from "../use-settings.js";

/** Controls take their shape and colours from the active theme. */
const CONTROL_CLASS =
  "rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-(--accent-primary) focus:ring-1 focus:ring-(--accent-primary)";

export interface InheritedSettingValue {
  readonly value: unknown;
  /** The name of what supplies the value, for the player: a world's name. */
  readonly source: string;
}

/**
 * The value in force for a key the player has not set, when it is not the
 * registered default: a world's own default for one of its plugins. The pane
 * that knows the world provides it, keyed by setting key.
 */
export const InheritedSettingValues = createContext<
  ReadonlyMap<string, InheritedSettingValue>
>(new Map());

/** `useSetting`, reading the inherited value while the player has set none. */
function useEffectiveSetting<T>(
  entry: SettingEntry,
): [T, (value: T) => Promise<void>] {
  const [stored, setValue] = useSetting<T>(entry.key);
  const [overridden] = useSettingOverride(entry.key);
  const inherited = useContext(InheritedSettingValues).get(entry.key);
  return [!overridden && inherited ? (inherited.value as T) : stored, setValue];
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
  controlId,
  inline = false,
  children,
}: {
  entry: SettingEntry;
  controlId?: string;
  /** Put the control beside the text instead of under it. */
  inline?: boolean;
  children: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const description = resolveSettingEntryText(entry, "description", locale);
  const inherited = useContext(InheritedSettingValues).get(entry.key);
  const [overridden] = useSettingOverride(entry.key);
  const range =
    typeof entry.min === "number" && typeof entry.max === "number"
      ? t("settings.valueRange", {
          min: entry.min.toLocaleString(locale),
          max: entry.max.toLocaleString(locale),
        })
      : "";
  const text = (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Label
          id={settingLabelId(entry.key)}
          htmlFor={controlId}
          className="text-[13px] font-medium leading-snug text-foreground"
        >
          {resolveSettingEntryText(entry, "label", locale)}
        </Label>
        <UseDefaultButton entry={entry} />
      </div>
      {(description || range) && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {[description, range].filter(Boolean).join(" ")}
        </p>
      )}
      {inherited && !overridden && (
        <p className="text-xs leading-relaxed text-(--accent-primary)">
          {t("settings.followsWorldDefault", { world: inherited.source })}
        </p>
      )}
    </div>
  );
  if (inline) {
    return (
      <div className="flex items-start justify-between gap-4">
        {text}
        {children}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {text}
      {children}
    </div>
  );
}

/**
 * A value the player set stays in force over a world's or a plugin's default
 * until it is cleared, so every set value needs a way back.
 */
function UseDefaultButton({ entry }: { entry: SettingEntry }) {
  const { t } = useTranslation();
  const [overridden, restoreDefault] = useSettingOverride(entry.key);
  if (!overridden || entry.secret || entry.backend === "keys") return null;
  return (
    <button
      type="button"
      onClick={() => void restoreDefault()}
      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {t("settings.useDefault")}
    </button>
  );
}

/**
 * Edit text locally and write the setting when the field is left. A write per
 * key press validates every half-typed value, so "30" could not become "300"
 * through "3", and each key press saved the whole settings file.
 */
function useDraft(stored: string, commit: (draft: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef({ draft, commit });
  useEffect(() => {
    latest.current = { draft, commit };
  });
  // Escape closes the dialog and unmounts the field without a blur.
  useEffect(
    () => () => {
      const pending = latest.current;
      if (pending.draft !== null) pending.commit(pending.draft);
    },
    [],
  );
  return {
    text: draft ?? stored,
    setDraft,
    flush: () => {
      if (draft === null) return;
      setDraft(null);
      commit(draft);
    },
  };
}

/** The number a draft stands for: inside the declared range and valid for the entry. */
function numberFromDraft(
  entry: SettingEntry,
  draft: string,
): number | undefined {
  if (draft.trim() === "") return undefined;
  let value = Number(draft);
  if (!Number.isFinite(value)) return undefined;
  if (typeof entry.min === "number") value = Math.max(entry.min, value);
  if (typeof entry.max === "number") value = Math.min(entry.max, value);
  if (entry.schema.safeParse(value).success) return value;
  const rounded = Math.round(value);
  return entry.schema.safeParse(rounded).success ? rounded : undefined;
}

function useNumberDraft(entry: SettingEntry) {
  const [value, setValue] = useEffectiveSetting<number>(entry);
  const draft = useDraft(String(value ?? ""), (text) => {
    const next = numberFromDraft(entry, text);
    if (next !== undefined && next !== value) void setValue(next);
  });
  return { value, ...draft };
}

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") event.currentTarget.blur();
}

function settingControlId(key: string, suffix?: string): string {
  return `setting-${key}${suffix ? `-${suffix}` : ""}`;
}

function settingLabelId(key: string): string {
  return `${settingControlId(key)}-label`;
}

function TextWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useEffectiveSetting<string>(entry);
  const controlId = settingControlId(entry.key);
  const draft = useDraft(value ?? "", (text) => {
    if (text !== value) void setValue(text);
  });
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <input
        id={controlId}
        type="text"
        value={draft.text}
        onChange={(e) => draft.setDraft(e.target.value)}
        onBlur={draft.flush}
        onKeyDown={blurOnEnter}
        className={`w-full px-3 py-2 ${CONTROL_CLASS}`}
      />
    </FieldShell>
  );
}

function NumberWidget({ entry }: { entry: SettingEntry }) {
  const draft = useNumberDraft(entry);
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <input
        id={controlId}
        type="number"
        min={entry.min}
        max={entry.max}
        step={entry.step}
        value={draft.text}
        onChange={(e) => draft.setDraft(e.target.value)}
        onBlur={draft.flush}
        onKeyDown={blurOnEnter}
        className={`w-40 max-w-full px-3 py-2 font-mono ${CONTROL_CLASS}`}
      />
    </FieldShell>
  );
}

function ToggleWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useEffectiveSetting<boolean>(entry);
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId} inline>
      <button
        id={controlId}
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => void setValue(!value)}
        className={
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors " +
          (value
            ? "border-(--accent-primary) bg-(--accent-primary)"
            : "border-(--rule-color) bg-(--surface-inset)")
        }
      >
        <span
          className={
            "inline-block h-3.5 w-3.5 rounded-full transition-transform " +
            (value
              ? "translate-x-4.5 bg-(--surface-page)"
              : "translate-x-0.5 bg-muted-foreground")
          }
        />
      </button>
    </FieldShell>
  );
}

function SelectWidget({ entry }: { entry: SettingEntry }) {
  const [value, setValue] = useEffectiveSetting<string>(entry);
  const { i18n } = useTranslation();
  const controlId = settingControlId(entry.key);
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <select
        id={controlId}
        value={value ?? ""}
        onChange={(e) => void setValue(e.target.value)}
        className={`w-full px-3 py-2 sm:w-72 ${CONTROL_CLASS}`}
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
  const draft = useNumberDraft(entry);
  const min = entry.min ?? 0;
  const max = entry.max ?? 1;
  const step = entry.step ?? 0.1;
  const rangeId = settingControlId(entry.key);
  const numberId = settingControlId(entry.key, "number");
  const position = Number(draft.text);
  return (
    <FieldShell entry={entry} controlId={rangeId}>
      <div className="flex items-center gap-2">
        <input
          id={rangeId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(position) ? position : min}
          onChange={(e) => draft.setDraft(e.target.value)}
          onPointerUp={draft.flush}
          onKeyUp={draft.flush}
          onBlur={draft.flush}
          className="flex-1 accent-(--accent-primary)"
        />
        <input
          id={numberId}
          aria-labelledby={settingLabelId(entry.key)}
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft.text}
          onChange={(e) => draft.setDraft(e.target.value)}
          onBlur={draft.flush}
          onKeyDown={blurOnEnter}
          className={`w-20 px-2 py-1.5 text-center font-mono ${CONTROL_CLASS}`}
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
  const stored = serverManaged ? "" : (value ?? "");
  const draft = useDraft(stored, (text) => {
    if (text !== stored) void setValue(text);
  });
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <div className="flex gap-1">
        <input
          id={controlId}
          type={visible ? "text" : "password"}
          value={draft.text}
          onChange={(e) => draft.setDraft(e.target.value)}
          onBlur={draft.flush}
          onKeyDown={blurOnEnter}
          placeholder={
            serverManaged
              ? t(
                  "settings.serverManagedKeyPlaceholder",
                  "Configured on this device; enter a value to replace",
                )
              : "sk-..."
          }
          className={`min-w-0 flex-1 px-3 py-2 font-mono ${CONTROL_CLASS}`}
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
  const [value, setValue] = useEffectiveSetting<string>(entry);
  const controlId = settingControlId(entry.key);
  const draft = useDraft(value ?? "", (text) => {
    if (text !== value) void setValue(text);
  });
  return (
    <FieldShell entry={entry} controlId={controlId}>
      <textarea
        id={controlId}
        value={draft.text}
        onChange={(e) => draft.setDraft(e.target.value)}
        onBlur={draft.flush}
        rows={4}
        className={`w-full px-3 py-2 font-mono ${CONTROL_CLASS}`}
      />
    </FieldShell>
  );
}

function JsonWidget({ entry }: { entry: SettingEntry }) {
  const [value] = useSetting<unknown>(entry.key);
  return (
    <FieldShell entry={entry}>
      <pre className="max-h-48 overflow-auto rounded-(--radius-control) border border-(--rule-color) bg-(--surface-inset) p-2 font-mono text-[11px]">
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
      <div className="rounded-(--radius-control) border border-dashed border-(--rule-color) p-3 text-xs italic text-muted-foreground">
        {t("settings.customWidgetUnavailable")}
      </div>
    </FieldShell>
  );
}
