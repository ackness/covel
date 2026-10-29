/** Static package validation shared by the CLI and the host. Never imports entries. */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PackageValidationIssue } from "@covel/shared";
import { discoverPluginAt } from "./discover.js";
import { loadPluginDefinition } from "./load.js";
import {
  packageModuleTypeProblem,
  validatePluginFiles,
} from "./static-validation.js";
import { validatePluginLabels } from "./locale-labels.js";
import { describePluginLanguages } from "./plugin-languages.js";
import { authoringWarnings } from "./authoring-warnings.js";

export interface PluginPackageValidation {
  readonly ok: boolean;
  readonly issues: PackageValidationIssue[];
  readonly id?: string;
  readonly version?: string;
  readonly languages?: string;
  /** CLI-only values; never send these over HTTP. */
  readonly rootPath: string;
  readonly cliFailure?: string;
  readonly cliWarnings: string[];
}

const slash = (value: string) => value.replace(/\\/g, "/");
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathFlags = (value: string) =>
  process.platform === "win32" ||
  /^[a-z]:/i.test(value) ||
  value.startsWith("//")
    ? "gi"
    : "g";

/** Remove package and host locations, including paths in nested validator messages. */
export function redactPaths(
  text: string,
  options: { root: string; extra?: readonly string[] },
): string {
  let result = slash(text);
  const root = slash(options.root).replace(/\/$/, "");
  result = result.replace(
    new RegExp(`${escapeRegex(root)}/`, pathFlags(root)),
    "",
  );
  result = result.replace(
    new RegExp(`${escapeRegex(root)}(?=$|[\\s:'"),;])`, pathFlags(root)),
    ".",
  );
  for (const prefix of [...(options.extra ?? [])].sort(
    (a, b) => b.length - a.length,
  )) {
    const normalized = slash(prefix).replace(/\/$/, "");
    if (!normalized) continue;
    result = result.replace(
      new RegExp(
        `${escapeRegex(normalized)}(?:/[^\\s'"<>),;:]*)?(?=$|[\\s:'"<>),;])`,
        pathFlags(normalized),
      ),
      "<path>",
    );
  }
  // Catch unrecognised host paths, UNC shares and paths relative to the host.
  return result
    .replace(/(?<![\w./:-])(?:[A-Za-z]:\/|\/\/)[^\s'"<>:(),;]+/g, "<path>")
    .replace(
      /(?<![\w./:-])\/(?:[^\s/'"<>:(),;]+\/){3,}[^\s'"<>:(),;]*/g,
      "<path>",
    )
    .replace(/(?<![\w./-])(?:\.\.\/)+[^\s'"<>:(),;]+/g, "<path>");
}

/** Best-effort locations from the static validators' existing text diagnostics. */
export function parseIssueLocation(
  message: string,
  root: string,
): { file?: string; field?: string; message: string } {
  let remaining = slash(message);
  const normalized = slash(root).replace(/\/$/, "");
  const compare = (value: string) =>
    pathFlags(normalized).includes("i") ? value.toLowerCase() : value;
  let file: string | undefined;
  let field: string | undefined;
  let located = false;
  while (true) {
    const delimiter = remaining.indexOf(": ");
    if (delimiter < 0) break;
    const token = remaining.slice(0, delimiter);
    const inside = compare(token).startsWith(`${compare(normalized)}/`);
    if (inside || compare(token) === compare(normalized)) {
      file = inside ? token.slice(normalized.length + 1) : undefined;
    } else if (
      !token.startsWith("/") &&
      !/^[A-Za-z]:/.test(token) &&
      /^(?:\.\/)?[\w./-]+\.(?:md|json|ya?ml|[cm]?[jt]s)$/.test(token)
    ) {
      file = token.replace(/^\.\//, "");
    } else if (located && /^[A-Za-z_][\w.[\]-]*$/.test(token)) {
      field = token;
    } else break;
    located = true;
    remaining = remaining.slice(delimiter + 2);
  }
  return {
    ...(file ? { file } : {}),
    ...(field ? { field } : {}),
    message: redactPaths(remaining, { root }),
  };
}

const ignoredHint =
  "remove it or correct its name using the current plugin manifest reference";
const llmWarning =
  "llm.toml is ignored: a plugin cannot choose a model or an endpoint. Name the role with agent.model / function.model; the player's model settings bind it.";

/** Shared CLI path handling, including multi-runtime manifest inputs. */
export async function normalizePluginPackagePath(
  input: string,
): Promise<string> {
  let root = path.resolve(input);
  if ((await fs.stat(root)).isFile()) root = path.dirname(root);
  if (path.basename(path.dirname(root)) === "runtimes")
    root = path.dirname(path.dirname(root));
  return fs.realpath(root);
}

export async function validatePluginPackage(
  input: string,
): Promise<PluginPackageValidation> {
  let rootPath = path.resolve(input);
  const issues: PackageValidationIssue[] = [];
  const cliWarnings: string[] = [];
  let cliFailure: string | undefined;
  let id: string | undefined;
  let version: string | undefined;
  let languages: string | undefined;
  function fail(code: string, error: unknown, cliText?: string) {
    const message = error instanceof Error ? error.message : String(error);
    cliFailure ??= cliText ?? message;
    for (const line of message.split("\n").filter(Boolean))
      issues.push({
        severity: "error",
        code,
        ...parseIssueLocation(line, rootPath),
      });
  }
  const result = (): PluginPackageValidation => ({
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    rootPath,
    id,
    version,
    languages,
    cliFailure,
    cliWarnings,
  });
  try {
    rootPath = await normalizePluginPackagePath(input);
  } catch (error) {
    fail("plugin-not-found", error);
    return result();
  }
  let discovery;
  try {
    discovery = await discoverPluginAt(rootPath);
    if (!discovery) {
      fail(
        "plugin-not-found",
        `${rootPath}: no enabled plugin with a root PLUGIN.md found`,
      );
      return result();
    }
    id = discovery.id;
    if (discovery.layoutWarnings?.length)
      fail("plugin-layout", discovery.layoutWarnings.join("\n"));
  } catch (error) {
    fail("plugin-layout", error);
    return result();
  }
  let definition;
  try {
    definition = await loadPluginDefinition(discovery);
  } catch (error) {
    fail("plugin-load", error);
    return result();
  }
  id = definition.packageManifest.plugin.id;
  version = definition.packageManifest.plugin.version;
  languages = describePluginLanguages(definition.languages);
  if (definition.disabledRuntimes.length) {
    cliFailure ??= definition.disabledRuntimes
      .map(({ message }) => message)
      .join("\n");
    for (const entry of definition.disabledRuntimes)
      issues.push({
        severity: "error",
        code: "runtime-disabled",
        ...parseIssueLocation(entry.message, rootPath),
        file: redactPaths(entry.sourcePath, { root: rootPath }),
      });
  }
  if (definition.ignoredFields.length) {
    cliFailure ??= definition.ignoredFields
      .map(({ message }) => `${message}; ${ignoredHint}`)
      .join("\n");
    for (const entry of definition.ignoredFields)
      issues.push({
        severity: "error",
        code: "unknown-field",
        ...parseIssueLocation(entry.message, rootPath),
        file: redactPaths(entry.sourcePath, { root: rootPath }),
        field: entry.field,
        hint: ignoredHint,
      });
  }
  try {
    validatePluginFiles(
      definition.packageManifest,
      definition.manifests,
      (file) => readFileSync(file, "utf8"),
    );
  } catch (error) {
    fail("plugin-files", error);
  }
  try {
    const pkg = await fs
      .readFile(path.join(rootPath, "package.json"), "utf8")
      .then(
        (content) => JSON.parse(content) as { type?: unknown },
        () => undefined,
      );
    const problem = pkg && packageModuleTypeProblem(pkg);
    if (problem) {
      fail("package-module-type", `${rootPath}: ${problem}`);
      const issue = issues.at(-1);
      if (issue) issue.file = "package.json";
    }
  } catch (error) {
    fail("package-module-type", error);
  }
  try {
    const problems = await validatePluginLabels(rootPath);
    if (problems.length) {
      cliFailure ??= `${rootPath}: locale files\n  - ${problems.join("\n  - ")}`;
      for (const problem of problems) fail("locale-files", problem);
    }
  } catch (error) {
    fail("locale-files", error);
  }
  try {
    for (const warning of authoringWarnings(
      definition.packageManifest,
      definition.manifests,
    )) {
      issues.push({
        severity: "warning",
        code: "authoring-warning",
        ...parseIssueLocation(warning, rootPath),
      });
      if (!cliFailure) cliWarnings.push(`  warning: ${warning}`);
    }
    if (
      await fs.stat(path.join(rootPath, "llm.toml")).then(
        () => true,
        () => false,
      )
    ) {
      issues.push({
        severity: "warning",
        code: "llm-toml-ignored",
        file: "llm.toml",
        message: llmWarning,
      });
      if (!cliFailure) cliWarnings.push(`  warning: ${llmWarning}`);
    }
  } catch (error) {
    fail("authoring-warning", error);
  }
  return result();
}
