import type { ComponentRenderer } from "@json-render/react";
import { useId } from "react";
import { useStateStore } from "@json-render/react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { useI18nResolver } from "./helpers.js";

// ── Message Components (for chat area rendering) ─────────────────

/** Prose — renders narrative text as styled paragraphs. */
export const Prose: ComponentRenderer = ({ element }) => {
  const content = (element.props?.content as string) ?? "";
  const paragraphs = content.split(/\n\n+/).filter(Boolean);

  return (
    <div className="ui-narrative space-y-5 max-w-(--story-max-width)">
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.split(/(\*\*[^*]+\*\*)/).map((segment, j) =>
            segment.startsWith("**") && segment.endsWith("**") ? (
              <strong key={j} className="font-semibold">
                {segment.slice(2, -2)}
              </strong>
            ) : (
              segment
            ),
          )}
        </p>
      ))}
    </div>
  );
};

/** PlayerMessage — renders player's input message (right-aligned bubble).
 *  In Paper, follows Variant A's editorial "YOU" convention: left-aligned
 *  with a 2px accent bar and a mono uppercase eyebrow. */
export const PlayerMessage: ComponentRenderer = ({ element }) => {
  const { t } = useTranslation();
  const content = (element.props?.content as string) ?? "";
  return (
    <div className="ui-player-message-row flex justify-end">
      <div className="ui-message-player max-w-[80%] px-4 py-2.5 text-sm leading-relaxed">
        <span className="ui-eyebrow mb-1 block text-primary">
          {t("interaction.playerLabel", "You")}
        </span>
        <span className="text-[14px] leading-[1.6]">{content}</span>
      </div>
    </div>
  );
};

/** Alert — renders notifications (info, success, warning, error). */
export const Alert: ComponentRenderer = ({ element }) => {
  const resolve = useI18nResolver();
  const level = (element.props?.level as string) ?? "info";
  const title = resolve(element.props?.title);
  const message = resolve(element.props?.message);

  const toneMap: Record<string, "success" | "warning" | "danger" | "info"> = {
    success: "success",
    warning: "warning",
    error: "danger",
    info: "info",
  };
  const textColorMap: Record<string, string> = {
    success: "text-(--accent-success)",
    warning: "text-(--accent-warning)",
    error: "text-(--accent-danger)",
    info: "text-(--accent-secondary)",
  };

  return (
    <div className="ui-band text-sm" data-tone={toneMap[level]}>
      {title && (
        <div
          className={clsx(
            "ui-eyebrow font-medium text-[11px] mb-1",
            textColorMap[level],
          )}
        >
          {title}
        </div>
      )}
      {message && (
        <div className="text-[13px] leading-[1.55] text-foreground/90">
          {message}
        </div>
      )}
    </div>
  );
};

/** FormField — a single form field (text input or select). */
export const FormField: ComponentRenderer = ({ element, bindings }) => {
  const { t } = useTranslation();
  const resolve = useI18nResolver();
  const fieldId = useId();
  const fieldType = (element.props?.fieldType as string) ?? "text";
  const label = resolve(element.props?.label);
  const placeholder = resolve(element.props?.placeholder);
  const required = element.props?.required as boolean;
  const options = element.props?.options as
    Array<{ value: string; label: string }> | undefined;
  const rawValue = element.props?.value;
  const value =
    typeof rawValue === "string" || typeof rawValue === "number"
      ? rawValue
      : "";
  const disabled = element.props?.disabled as boolean;
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  const fieldCls =
    "ui-input-shell w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 text-foreground placeholder:text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={fieldId}
        className="ui-eyebrow text-xs text-muted-foreground"
      >
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive ml-0.5">
            *
          </span>
        )}
      </label>
      {fieldType === "select" && options ? (
        <select
          id={fieldId}
          required={required}
          value={value}
          onChange={(e) => bindPath && set(bindPath, e.target.value)}
          disabled={disabled}
          className={fieldCls}
        >
          <option value="">
            {placeholder ?? t("form.selectPrefix", { label })}
          </option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : fieldType === "textarea" ? (
        <textarea
          id={fieldId}
          value={value}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          className={fieldCls}
          onChange={(e) => bindPath && set(bindPath, e.target.value)}
        />
      ) : fieldType === "checkbox" ? (
        <input
          id={fieldId}
          type="checkbox"
          checked={rawValue === true || rawValue === "true"}
          disabled={disabled}
          onChange={(e) => bindPath && set(bindPath, e.target.checked)}
        />
      ) : (
        <input
          id={fieldId}
          type={fieldType === "number" ? "number" : "text"}
          min={element.props?.min as number | undefined}
          max={element.props?.max as number | undefined}
          step={element.props?.step as number | undefined}
          required={required}
          value={value}
          onChange={(e) =>
            bindPath &&
            set(
              bindPath,
              fieldType === "number" && e.target.value !== ""
                ? e.target.valueAsNumber
                : e.target.value,
            )
          }
          placeholder={placeholder}
          disabled={disabled}
          className={fieldCls}
        />
      )}
    </div>
  );
};

/** SubmitButton — styled form submit button with disabled state. */
export const SubmitButton: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const disabled = element.props?.disabled as boolean;

  return (
    <button
      type="button"
      data-testid="interaction-submit"
      onClick={() => emit("click")}
      disabled={disabled}
      className={clsx(
        "w-full py-3 text-sm font-medium rounded-(--radius-control) transition-colors tracking-[0.04em]",
        disabled
          ? "bg-muted text-muted-foreground cursor-not-allowed"
          : "bg-foreground text-(--surface-page) hover:opacity-90",
      )}
    >
      {label}
    </button>
  );
};
