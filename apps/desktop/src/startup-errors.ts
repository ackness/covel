import { t } from "./main-i18n.js";

export interface DiagnosedError {
  title: string;
  detail: string;
  hint?: string;
}

export function diagnoseStartupError(err: unknown): DiagnosedError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    return {
      title: t("startup.portConflict.title"),
      detail: msg,
      hint: t("startup.portConflict.hint"),
    };
  }
  if (/EACCES|permission denied/i.test(msg)) {
    return {
      title: t("startup.permissionDenied.title"),
      detail: msg,
      hint: t("startup.permissionDenied.hint"),
    };
  }
  if (/did not start within|timeout/i.test(msg)) {
    return {
      title: t("startup.timeout.title"),
      detail: msg,
      hint: t("startup.timeout.hint"),
    };
  }
  if (/ENOENT/i.test(msg)) {
    return {
      title: t("startup.missingFile.title"),
      detail: msg,
      hint: t("startup.missingFile.hint"),
    };
  }
  return { title: t("startup.failed.title"), detail: msg };
}
