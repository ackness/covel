import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { resolveI18nText } from "@covel/shared";
import { toSwatchHex, isValidCssColor } from "@/theme-system/color.js";
import type { ThemeScheme } from "@/theme-system/types.js";
import {
  formatLength,
  parseLength,
  FONT_STACKS,
  type TokenSpec,
} from "@/theme-system/token-schema.js";

/** How long the control stays quiet before writing through to the store. */
const COMMIT_DELAY_MS = 200;

interface TokenControlProps {
  readonly spec: TokenSpec;
  readonly scheme: ThemeScheme;
  /** Value from the theme when nothing is overridden. */
  readonly themeDefault: string;
  /** Player override, or null when the theme value is in effect. */
  readonly override: string | null;
  readonly onCommit: (value: string) => void;
  readonly onReset: () => void;
}

/**
 * Drag-to-preview, commit-on-settle.
 *
 * A range input fires on every frame; persisting each one would write
 * localStorage 60×/second. So the draft paints straight onto `<html>` for
 * instant feedback and only the settled value reaches the store — which then
 * re-applies the exact same property, making the handoff invisible.
 */
function useLiveValue(
  spec: TokenSpec,
  scheme: ThemeScheme,
  committed: string,
  onCommit: (value: string) => void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    commit: () => void;
  } | null>(null);
  const cancel = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);
  const flush = useCallback(() => {
    const commit = pending.current?.commit;
    cancel();
    commit?.();
  }, [cancel]);

  // Save the last edit in its original scheme before switching or closing.
  useEffect(() => flush, [scheme, flush]);

  // A scheme or theme switch changes `committed` underneath us; drop the stale
  // draft so the control shows what is actually on screen.
  useEffect(() => {
    cancel();
    setDraft(null);
  }, [committed, scheme, cancel]);

  function preview(next: string): void {
    setDraft(next);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty(spec.name, next);
    }
    cancel();
    pending.current = {
      timer: setTimeout(flush, COMMIT_DELAY_MS),
      commit: () => onCommit(next),
    };
  }

  function reset(): void {
    cancel();
    setDraft(null);
    document.documentElement.style.removeProperty(spec.name);
  }

  return { value: draft ?? committed, preview, flush, reset };
}

export function TokenControl({
  spec,
  scheme,
  themeDefault,
  override,
  onCommit,
  onReset,
}: TokenControlProps) {
  const { t, i18n } = useTranslation();
  const committed = override ?? themeDefault;
  const { value, preview, flush, reset } = useLiveValue(
    spec,
    scheme,
    committed,
    onCommit,
  );
  const resetToken = () => {
    reset();
    onReset();
  };
  const label = resolveI18nText(spec.label, i18n.language) ?? spec.name;
  const labelId = useId();
  const hint = spec.hint ? resolveI18nText(spec.hint, i18n.language) : null;

  return (
    // Deliberately not `.ui-band`: that atom is display:block and paints an
    // accent bar per row, which reads as noise across 45 stacked controls.
    <div
      onBlur={flush}
      className="flex items-center justify-between gap-4 border-b border-(--rule-color) py-2 last:border-b-0"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          {override !== null && (
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: "var(--accent-primary)" }}
            />
          )}
          <span id={labelId} className="text-xs font-medium truncate">
            {label}
          </span>
        </div>
        {hint && (
          <p className="ui-meta normal-case tracking-normal text-[10px] leading-relaxed">
            {hint}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <TokenInput
          spec={spec}
          value={value}
          labelId={labelId}
          onPreview={preview}
          onReset={resetToken}
        />
        <button
          type="button"
          onClick={resetToken}
          disabled={override === null}
          aria-label={t("appearance.resetToken")}
          title={t("appearance.resetToken")}
          className="shrink-0 p-1 text-muted-foreground transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

interface TokenInputProps {
  readonly spec: TokenSpec;
  readonly value: string;
  readonly labelId: string;
  readonly onPreview: (value: string) => void;
  readonly onReset: () => void;
}

function TokenInput({
  spec,
  value,
  labelId,
  onPreview,
  onReset,
}: TokenInputProps) {
  switch (spec.control) {
    case "color":
      return (
        <ColorInput value={value} labelId={labelId} onPreview={onPreview} />
      );
    case "length":
      return (
        <LengthInput
          spec={spec}
          value={value}
          labelId={labelId}
          onPreview={onPreview}
        />
      );
    case "number":
      return (
        <NumberInput
          spec={spec}
          value={value}
          labelId={labelId}
          onPreview={onPreview}
        />
      );
    case "font":
      return (
        <PresetInput
          value={value}
          labelId={labelId}
          onPreview={onPreview}
          onReset={onReset}
          options={spec.options ?? FONT_STACKS}
          previewFont
        />
      );
    case "css":
      return (
        <PresetInput
          value={value}
          labelId={labelId}
          onPreview={onPreview}
          onReset={onReset}
          options={spec.options ?? []}
        />
      );
    case "select":
    default:
      return (
        <SelectInput
          spec={spec}
          value={value}
          labelId={labelId}
          onPreview={onPreview}
        />
      );
  }
}

const FIELD_CLASS =
  "border border-(--rule-color) bg-(--surface-page) px-2 py-1 text-[11px] font-mono outline-none focus:ring-1 focus:ring-(--accent-primary) rounded-(--radius-control)";

function ColorInput({
  value,
  labelId,
  onPreview,
}: {
  value: string;
  labelId: string;
  onPreview: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const swatch = toSwatchHex(value) ?? "#000000";
  const valid = !text.trim() || isValidCssColor(text);
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={swatch}
        onChange={(event) => onPreview(event.target.value)}
        aria-labelledby={labelId}
        className="h-6 w-8 cursor-pointer border border-(--rule-color) bg-transparent p-0.5 rounded-(--radius-control)"
      />
      <input
        type="text"
        value={text}
        aria-labelledby={labelId}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          // Only push valid colours through; an in-progress "oklch(" must not
          // wipe the live value mid-keystroke.
          if (isValidCssColor(event.target.value))
            onPreview(event.target.value);
        }}
        className={`${FIELD_CLASS} w-40 ${valid ? "" : "text-(--accent-danger)"}`}
      />
    </div>
  );
}

function LengthInput({
  spec,
  value,
  labelId,
  onPreview,
}: {
  spec: TokenSpec;
  value: string;
  labelId: string;
  onPreview: (value: string) => void;
}) {
  const unit = spec.unit ?? "rem";
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const step = spec.step ?? 0.05;
  const parsed = parseLength(value, unit);
  // A computed value in another unit (or a clamp()) cannot drive a slider;
  // the text field still accepts it verbatim.
  const amount = parsed ?? min;

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={amount}
        aria-labelledby={labelId}
        disabled={parsed === null}
        onChange={(event) =>
          onPreview(formatLength(Number(event.target.value), unit))
        }
        className="w-28 accent-(--accent-primary)"
      />
      <input
        type="text"
        value={value}
        aria-labelledby={labelId}
        spellCheck={false}
        onChange={(event) => onPreview(event.target.value)}
        className={`${FIELD_CLASS} w-20 text-center`}
      />
    </div>
  );
}

function NumberInput({
  spec,
  value,
  labelId,
  onPreview,
}: {
  spec: TokenSpec;
  value: string;
  labelId: string;
  onPreview: (value: string) => void;
}) {
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const step = spec.step ?? 0.05;
  const numeric = Number(value);
  const amount = Number.isFinite(numeric) ? numeric : min;

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={amount}
        aria-labelledby={labelId}
        onChange={(event) => onPreview(event.target.value)}
        className="w-28 accent-(--accent-primary)"
      />
      <span className={`${FIELD_CLASS} w-20 text-center tabular-nums`}>
        {Number(amount.toFixed(3))}
      </span>
    </div>
  );
}

function SelectInput({
  spec,
  value,
  labelId,
  onPreview,
}: {
  spec: TokenSpec;
  value: string;
  labelId: string;
  onPreview: (value: string) => void;
}) {
  const { i18n } = useTranslation();
  const options = spec.options ?? [];
  const known = options.some((option) => option.value === value.trim());

  return (
    <select
      aria-labelledby={labelId}
      value={known ? value.trim() : ""}
      onChange={(event) => onPreview(event.target.value)}
      className={`${FIELD_CLASS} w-40`}
    >
      {!known && <option value="">{value || "—"}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {resolveI18nText(option.label, i18n.language) ?? option.value}
        </option>
      ))}
    </select>
  );
}

/**
 * Preset dropdown paired with a free-text field: the list covers the common
 * choices, the field keeps every CSS value the token legally accepts (a font
 * stack the player has installed, a `url(...)` backdrop).
 *
 * The empty option means "follow the theme" and clears the override rather
 * than writing one. A theme's own value is a resolved stack that will rarely
 * string-match a preset, so the dropdown is a chooser, not a readout — the
 * text field is what shows what is actually in effect.
 */
function PresetInput({
  value,
  labelId,
  onPreview,
  onReset,
  options,
  previewFont = false,
}: {
  value: string;
  labelId: string;
  onPreview: (value: string) => void;
  onReset: () => void;
  options: readonly { value: string; label: unknown }[];
  previewFont?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const matched = options.find((option) => option.value === value.trim());

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-labelledby={labelId}
        value={matched?.value ?? ""}
        onChange={(event) => {
          if (!event.target.value) {
            onReset();
            return;
          }
          onPreview(event.target.value);
        }}
        className={`${FIELD_CLASS} w-36`}
      >
        <option value="">{t("appearance.followTheme")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {resolveI18nText(option.label as never, i18n.language) ??
              option.value}
          </option>
        ))}
      </select>
      <input
        type="text"
        aria-labelledby={labelId}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          onPreview(event.target.value);
        }}
        style={previewFont ? { fontFamily: value } : undefined}
        className={`${FIELD_CLASS} w-40`}
      />
    </div>
  );
}
