import path from "node:path";
import { pluginUiSpecIssues } from "@covel/shared";
import { readPlainYamlFrontmatter } from "./plain-yaml-frontmatter.js";
import { planPluginAssetRoot } from "./ui-assets.js";
import { PLUGIN_UI_SLOTS } from "./ui-spec.js";
import type { PackageFile } from "./package-inventory.js";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";

export interface PluginExecutionAssessment {
  readonly mode: "declarative" | "code" | "unknown";
  /** Package-relative author diagnostics; no prompt text or host paths. */
  readonly diagnostics: readonly {
    file: string;
    field?: string;
    message: string;
  }[];
}

/** Host-only evidence binding the parsed definition to the inspected files. */
export interface PluginExecutionProof extends PluginExecutionAssessment {
  readonly signature?: string;
  readonly digest?: string;
}

export function unknownExecutionAssessment(): PluginExecutionAssessment {
  return {
    mode: "unknown",
    diagnostics: [
      {
        file: "PLUGIN.md",
        message:
          "Package inspection is incomplete or changed; reload a readable, stable package.",
      },
    ],
  };
}

const executableFile = /\.(?:[cm]?[jt]sx?|node|wasm)$/i;
const manifestFile =
  /^(?:PLUGIN(?:\.[a-zA-Z0-9-]+)?|runtimes\/[^/]+\/RUNTIME(?:\.[a-zA-Z0-9-]+)?)\.md$/;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonempty = (value: unknown) =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(record(value)).length > 0
      : true);

/** Pure assessment shared by archive, discovery and author validation. Never imports code. */
export function assessPluginExecution({
  files,
  directories = [],
  root,
  runtimes,
}: {
  files: readonly PackageFile[];
  directories?: readonly string[];
  root: ParsedPluginMd;
  runtimes: readonly ParsedRuntimeMd[];
}): PluginExecutionAssessment {
  const diagnostics: { file: string; field?: string; message: string }[] = [];
  let incomplete = false;
  const code = (file: string, field: string) =>
    diagnostics.push({
      file,
      field,
      message: `${field} requires server-code authorization.`,
    });
  const runtime = (value: unknown, file: string, prefix = "") => {
    const declaration = record(value);
    for (const field of ["function", "guard"])
      if (declaration[field] !== undefined) code(file, `${prefix}${field}`);
    if (nonempty(record(declaration.permissions).http))
      code(file, `${prefix}permissions.http`);
  };
  const inspect = (
    data: Record<string, unknown>,
    file: string,
    packageRoot: boolean,
  ) => {
    if (!packageRoot) return runtime(data, file);
    if (data.entry !== undefined) code(file, "entry");
    if (nonempty(record(data.permissions).http)) code(file, "permissions.http");
    const contributes = record(data.contributes);
    for (const field of [
      "hooks",
      "tools",
      "wires",
      "services",
      "actions",
      "forms",
      "extensions",
      "worldProjections",
    ])
      if (nonempty(contributes[field])) code(file, `contributes.${field}`);
    runtime(data.runtime, file, "runtime.");
  };
  const inventory = new Map<string, PackageFile>();
  for (const file of files) {
    const name = file.relativePath;
    if (
      name.includes("\\") ||
      name.includes("\0") ||
      path.posix.isAbsolute(name) ||
      /^[a-z]:/i.test(name) ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      inventory.has(name)
    ) {
      incomplete = true;
      continue;
    }
    inventory.set(name, file);
    if (!manifestFile.test(name)) continue;
    try {
      inspect(
        readPlainYamlFrontmatter(Buffer.from(file.content).toString("utf8"))
          .data,
        name,
        !name.startsWith("runtimes/"),
      );
    } catch {
      incomplete = true;
    }
  }
  if (!inventory.has("PLUGIN.md")) incomplete = true;
  // Include derived paths and original declarations even when loading omitted a runtime.
  inspect(root.rawFrontmatter, "PLUGIN.md", true);
  inspect(record(root.plugin), "PLUGIN.md", true);
  if (root.plugin.entry) code("PLUGIN.md", "entry");
  if (inventory.has("server/index.js")) code("server/index.js", "entry");
  for (const parsed of runtimes) {
    const file = parsed.sourcePath
      ? path
          .relative(
            path.dirname(root.sourcePath ?? "PLUGIN.md"),
            parsed.sourcePath,
          )
          .split(path.sep)
          .join("/")
      : "RUNTIME.md";
    runtime(parsed.runtime, file);
    if (parsed.manifest.handler) code(file, "function.handler");
    if (parsed.manifest.guard) code(file, "guard");
  }
  const browserFiles = new Set<string>();
  const viewIds = new Set<string>();
  for (const slot of PLUGIN_UI_SLOTS)
    for (const reference of root.plugin.contributes?.ui?.[slot] ?? []) {
      try {
        const specPath = localPath("", reference);
        if (!specPath || !reference.endsWith(".json")) continue;
        const file = inventory.get(specPath);
        if (!file) continue;
        const spec: unknown = JSON.parse(
          Buffer.from(file.content).toString("utf8"),
        );
        if (pluginUiSpecIssues(spec, root.plugin.id, slot).length) continue;
        const value = record(spec);
        if (slot === "view" && typeof value.id === "string") {
          if (viewIds.has(value.id)) continue;
          viewIds.add(value.id);
        }
        const webview = record(value.webview);
        if (
          typeof webview.root !== "string" ||
          typeof webview.entry !== "string"
        )
          continue;
        const assetRoot = localPath("", webview.root);
        if (!assetRoot) continue;
        const prefix = `${assetRoot}/`;
        const plan = planPluginAssetRoot(
          [
            ...files
              .filter((f) => f.relativePath.startsWith(prefix))
              .map((f) => ({
                relativePath: f.relativePath.slice(prefix.length),
                size: f.content.byteLength,
              })),
            ...directories
              .filter((dir) => dir.startsWith(prefix))
              .map((dir) => ({
                relativePath: dir.slice(prefix.length) + "/",
                size: 0,
              })),
          ],
          path.posix.normalize(webview.entry),
        );
        if (plan.issues.length) continue;
        for (const name of plan.listed.keys()) browserFiles.add(prefix + name);
      } catch {
        // A broken UI feature supplies no browser exception.
      }
    }
  for (const name of inventory.keys())
    if (executableFile.test(name) && !browserFiles.has(name))
      code(name, "file");
  if (incomplete)
    return {
      ...unknownExecutionAssessment(),
      diagnostics: [
        ...diagnostics,
        ...unknownExecutionAssessment().diagnostics,
      ],
    };
  return { mode: diagnostics.length ? "code" : "declarative", diagnostics };
}

function localPath(base: string, reference: string): string | undefined {
  if (
    path.posix.isAbsolute(reference) ||
    reference.includes("\\") ||
    /^[a-z]:/i.test(reference) ||
    reference.split("/").includes("..")
  )
    return undefined;
  const resolved = path.posix.normalize(path.posix.join(base, reference));
  return resolved === "." || resolved.startsWith("../")
    ? undefined
    : resolved.replace(/\/$/, "");
}
