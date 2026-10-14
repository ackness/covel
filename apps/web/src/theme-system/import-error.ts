import type { TFunction } from "i18next";

export type ThemeImportErrorCode =
  | "invalid-id"
  | "invalid-json"
  | "invalid-manifest"
  | "missing-scope"
  | "multiple-ids"
  | "id-mismatch"
  | "escapes-scope"
  | "import-rule"
  | "builtin-id"
  | "theme-changed";

export class ThemeImportError extends Error {
  override readonly name = "ThemeImportError";
  constructor(
    readonly code: ThemeImportErrorCode,
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(code);
  }
}

export function themeImportErrorText(
  error: unknown,
  t: TFunction,
  fallbackKey: string,
): string {
  return error instanceof ThemeImportError
    ? t(`settings.themeImportErrors.${error.code}`, error.params)
    : t(fallbackKey);
}
