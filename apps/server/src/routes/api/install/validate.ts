import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  readRuntimeEnv,
  type PackageValidationIssue,
  type PackageValidationReport,
} from "@covel/shared";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginSummary,
  redactPaths,
  validatePluginPackage,
} from "@covel/plugin-loader";
import { resolveValidationSource } from "../../../lib/package-validation-source.js";
import { runSerial } from "../../../lib/serial-queue.js";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import {
  validateWorldPackage,
  type PluginCatalogue,
} from "../../../world-data/validate-world-package.js";
import { errorBody } from "../../../api-error.js";
import { errorResponse, httpError } from "./shared.js";

export const packageValidationRoutes = new Hono();

/** Static catalogue for bare hosts: do not run discovery's update/entry bootstrap. */
async function bundledCatalogue(): Promise<PluginCatalogue> {
  const dir =
    readRuntimeEnv().pluginsDir ??
    path.resolve(import.meta.dirname, "../../../../../../plugins");
  if (!(await stat(dir).catch(() => undefined))?.isDirectory())
    throw httpError(503, "Plugin catalogue is unavailable");
  const registry = createPluginRegistry();
  for (const discovery of await discoverPlugins(dir)) {
    try {
      const definition = await loadPluginDefinition(discovery);
      registry.register({
        id: discovery.id,
        rootPath: discovery.rootPath,
        summary: await loadPluginSummary(discovery, undefined, definition),
        ...definition,
        loadedRuntimes: new Map(),
        status: "registered",
      });
    } catch {
      // Invalid neighbours are unavailable providers, not validation blockers.
    }
  }
  return registry;
}

/** Public reports contain only bounded, package-relative diagnostic data. */
export function validationReport(
  kind: "plugin" | "world",
  root: string,
  issues: readonly PackageValidationIssue[],
  id?: string,
  summary?: PackageValidationReport["summary"],
): PackageValidationReport {
  const extra = [
    os.tmpdir(),
    os.homedir(),
    ...Object.values(resolveUserResourceDirs()),
  ];
  const redact = (value: string) => redactPaths(value, { root, extra });
  const publicIssue = (
    issue: PackageValidationIssue,
  ): PackageValidationIssue => ({
    severity: issue.severity,
    code: issue.code,
    ...(issue.file === undefined ? {} : { file: redact(issue.file) }),
    ...(issue.field === undefined ? {} : { field: redact(issue.field) }),
    message: redact(issue.message).slice(0, 2000),
    ...(issue.hint === undefined
      ? {}
      : { hint: redact(issue.hint).slice(0, 2000) }),
  });
  const shown = issues.slice(0, 200).map(publicIssue);
  if (issues.length > 200)
    shown.push({
      severity: "warning",
      code: "issues-truncated",
      message: `${issues.length - 200} additional issues omitted`,
    });
  // Keep a failing verdict even if errors occurred beyond the response cap.
  if (
    issues.some((issue) => issue.severity === "error") &&
    !shown.some((issue) => issue.severity === "error")
  ) {
    const error = issues.find((issue) => issue.severity === "error");
    if (error) shown[199] = publicIssue(error);
  }
  const errors = shown.filter((issue) => issue.severity === "error").length;
  return {
    kind,
    ...(id ? { id: redact(id) } : {}),
    ok: errors === 0,
    counts: { errors, warnings: shown.length - errors },
    issues: shown,
    ...(summary
      ? {
          summary: {
            ...(summary.version ? { version: redact(summary.version) } : {}),
            ...(summary.languages
              ? { languages: redact(summary.languages) }
              : {}),
          },
        }
      : {}),
  };
}

for (const kind of ["plugin", "world"] as const) {
  packageValidationRoutes.post(`/validate/${kind}`, async (c) => {
    let source: Awaited<ReturnType<typeof resolveValidationSource>> | undefined;
    try {
      source = await resolveValidationSource(c, kind, c.req.raw);
      const { dir, id, issues: sourceIssues = [] } = source;
      const report = await runSerial(async () => {
        if (kind === "plugin") {
          const result = await validatePluginPackage(dir);
          return validationReport(
            kind,
            dir,
            [...sourceIssues, ...result.issues],
            id === null ? undefined : (id ?? result.id),
            { version: result.version, languages: result.languages },
          );
        }
        const catalogue = c.get("pluginRegistry") ?? (await bundledCatalogue());
        const result = await validateWorldPackage({
          worldDir: dir,
          pluginsDirs: [],
          catalogue,
        });
        const issues = result.diagnostics.map(
          (diagnostic): PackageValidationIssue => ({
            severity: diagnostic.level,
            code: diagnostic.code,
            file: diagnostic.file,
            field: diagnostic.pointer,
            message:
              diagnostic.message +
              (diagnostic.sourceId || diagnostic.locales?.length
                ? ` (${[diagnostic.sourceId ? `source ${diagnostic.sourceId}` : "", diagnostic.locales?.length ? `locale ${diagnostic.locales.join(", ")}` : ""].filter(Boolean).join(", ")})`
                : ""),
            hint: diagnostic.hint,
          }),
        );
        return validationReport(
          kind,
          dir,
          [...sourceIssues, ...issues],
          id === null ? undefined : (id ?? result.worldId),
        );
      });
      return c.json(report);
    } catch (error) {
      let response;
      try {
        response = errorResponse(error);
      } catch {
        console.error("[package-validation] Validation failed:", error);
        response = errorResponse(httpError(500, "Package validation failed"));
      }
      const root = source?.dir ?? "/covel-validate-sentinel";
      const redact = (value: string) =>
        redactPaths(value, {
          root,
          extra: [
            os.tmpdir(),
            os.homedir(),
            ...Object.values(resolveUserResourceDirs()),
          ],
        });
      return c.json(
        errorBody(redact(response.body.error), {
          ...(response.body.error === "path-outside-roots"
            ? { code: "path-outside-roots" }
            : {}),
        }),
        response.status as ContentfulStatusCode,
      );
    } finally {
      await source?.cleanup();
    }
  });
}
