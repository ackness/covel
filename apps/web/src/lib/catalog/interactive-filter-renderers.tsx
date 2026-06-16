import type { ComponentRenderer } from "@json-render/react";
import { useStateStore } from "@json-render/react";
import { clsx } from "clsx";
import { resolveIcon, useI18nResolver } from "./helpers.js";
import { inputBase } from "./interactive-input-renderers.js";

export const Select: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const value = (element.props?.value as string) ?? "";
  const options =
    (element.props?.options as Array<{ value: string; label: unknown }>) ?? [];
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="space-y-1">
      {label && (
        <label className="ui-eyebrow text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={(e) => bindPath && set(bindPath, e.target.value)}
        className={inputBase}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {resolve(opt.label)}
          </option>
        ))}
      </select>
    </div>
  );
};

export const Switch: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const label = resolve(element.props?.label);
  const checked = (element.props?.checked as boolean) ?? false;
  const { set } = useStateStore();
  const bindPath = bindings?.checked;

  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <div
        role="switch"
        aria-checked={checked}
        onClick={() => bindPath && set(bindPath, !checked)}
        className={clsx(
          "w-8 h-4.5 rounded-full transition-colors relative",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <div
          className={clsx(
            "w-3.5 h-3.5 bg-background rounded-full absolute top-0.5 transition-transform shadow-sm",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </div>
      <span className="text-xs text-foreground">{label}</span>
    </label>
  );
};

export const FilterBar: ComponentRenderer = ({ element, bindings }) => {
  const resolve = useI18nResolver();
  const options =
    (element.props?.options as Array<{
      value: string;
      label: unknown;
      icon?: string;
    }>) ?? [];
  const value = (element.props?.value as string) ?? "all";
  const { set } = useStateStore();
  const bindPath = bindings?.value;

  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const active = value === opt.value;
        const OptIcon = resolveIcon(opt.icon);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => bindPath && set(bindPath, opt.value)}
            className={clsx(
              "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded-sm transition-colors",
              "ui-chip",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground",
            )}
          >
            {OptIcon && <OptIcon className="w-3 h-3" />}
            {resolve(opt.label)}
          </button>
        );
      })}
    </div>
  );
};
