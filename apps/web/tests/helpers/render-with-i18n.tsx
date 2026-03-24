// @vitest-environment jsdom

import React, { createElement, type ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";

import { I18nProvider, type Locale } from "../../src/i18n.js";

export function renderWithI18n(
  ui: ReactElement,
  options?: RenderOptions & {
    locale?: Locale;
  }
) {
  const { locale = "zh-CN", ...renderOptions } = options ?? {};

  return render(
    <I18nProvider initialLocale={locale}>{ui}</I18nProvider>,
    renderOptions
  );
}
