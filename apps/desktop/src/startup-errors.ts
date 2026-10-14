import { t } from "./main-i18n.js";

export interface DiagnosedError {
  title: string;
  detail: string;
  hint?: string;
}

export interface StartupErrorContext {
  /** The last lines the server wrote to stderr. */
  readonly logs?: string;
  readonly dataRoot?: string;
  readonly configTomlPath?: string;
}

/** The store refuses a database written with another data schema. */
const SCHEMA_MISMATCH = /StoreSchemaVersionError|store_schema_incompatible/;

export function diagnoseStartupError(
  err: unknown,
  context: StartupErrorContext = {},
): DiagnosedError {
  const msg = err instanceof Error ? err.message : String(err);
  if (SCHEMA_MISMATCH.test(msg) || SCHEMA_MISMATCH.test(context.logs ?? "")) {
    const line = [msg, ...(context.logs ?? "").split("\n")].find((text) =>
      /StoreSchemaVersionError:/.test(text),
    );
    return {
      title: t("startup.schemaMismatch.title"),
      detail: line?.replace(/^.*?StoreSchemaVersionError:\s*/, "") ?? msg,
      hint: t("startup.schemaMismatch.hint", {
        dataRoot: context.dataRoot ?? "~/.covel/data",
        configToml: context.configTomlPath ?? "~/.covel/config.toml",
      }),
    };
  }
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
