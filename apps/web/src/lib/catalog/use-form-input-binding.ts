import { useStateStore } from "@json-render/react";
import { useI18nResolver } from "./helpers.js";

/**
 * useFormInputBinding — shared logic for text-input renderers.
 *
 * Resolves the optional label string (i18n-aware), the current string value
 * from props (with a safe empty-string fallback), and returns a bound
 * `onChange` handler that writes through to the `$bindState` path when one
 * is configured.
 *
 * Eliminates the duplicated label + binding boilerplate that previously
 * appeared verbatim in Input, Textarea, and SearchInput.
 */
export function useFormInputBinding(
  propsLabel: unknown,
  propsValue: unknown,
  bindPath: string | undefined,
): {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
} {
  const resolve = useI18nResolver();
  const { set } = useStateStore();

  const label = resolve(propsLabel);
  const value = (propsValue as string) ?? "";

  function onChange(nextValue: string) {
    if (bindPath) set(bindPath, nextValue);
  }

  return { label, value, onChange };
}
