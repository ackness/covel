import {
  MAX_UI_WEBVIEW_BYTES,
  pluginUiSpecIssues,
  type PluginUiSpecIssue,
} from "@covel/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { compileUiText, readMessageCatalogs } from "./locale-messages.js";

async function containedFile(root: string, file: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(file),
  ]);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("UI asset escapes plugin root");
  return realFile;
}

/** A UI spec the host does not show, with what is wrong with it. */
class PluginUiSpecError extends Error {
  constructor(
    readonly issues: readonly PluginUiSpecIssue[],
    /** The spec's `id`, when it has one. */
    readonly specId?: string,
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "PluginUiSpecError";
  }
}

/**
 * Read one UI spec, check it with the rules static validation uses, and
 * expand its webview document. The browser runs that document in an opaque
 * sandbox. Throws {@link PluginUiSpecError} for a spec that breaks a rule.
 */
export async function loadPluginUiSpec(
  root: string,
  file: string,
  ownerPluginId: string,
): Promise<Record<string, unknown>> {
  const specPath = await containedFile(root, file);
  // The spec holds English text; `locales/<locale>.yaml` translates it.
  const spec = compileUiText(
    JSON.parse(await fs.readFile(specPath, "utf-8")) as Record<string, unknown>,
    await readMessageCatalogs(root),
  );
  const specId = typeof spec.id === "string" && spec.id ? spec.id : undefined;
  const issues = pluginUiSpecIssues(spec, ownerPluginId);
  if (issues.length) throw new PluginUiSpecError(issues, specId);
  const webview = spec.webview as
    { entry: string; height?: number } | undefined;
  if (webview) {
    const htmlPath = await containedFile(
      root,
      path.resolve(path.dirname(specPath), webview.entry),
    );
    if ((await fs.stat(htmlPath)).size > MAX_UI_WEBVIEW_BYTES)
      throw new PluginUiSpecError(
        [
          {
            path: "webview.entry",
            message: `the document exceeds ${MAX_UI_WEBVIEW_BYTES / 1024} KiB`,
          },
        ],
        specId,
      );
    spec.webview = {
      html: await fs.readFile(htmlPath, "utf-8"),
      ...(webview.height === undefined ? {} : { height: webview.height }),
    };
  }
  return spec;
}

export type PluginUiSlot = "right" | "message";

/** One declared UI spec the host does not show. */
export interface PluginUiSpecDiagnostic {
  readonly slot: PluginUiSlot;
  /** Position of the spec in `contributes.ui.<slot>`. */
  readonly specIndex: number;
  /** The path as the manifest declares it. */
  readonly declaredPath: string;
  /** The spec's `id`, when the file could be read. */
  readonly specId?: string;
  readonly issues: readonly PluginUiSpecIssue[];
}

export interface PluginUiSpecs {
  readonly slots: Partial<
    Record<PluginUiSlot, readonly Readonly<Record<string, unknown>>[]>
  >;
  readonly diagnostics: readonly PluginUiSpecDiagnostic[];
}

/**
 * Load the UI specs a package declares in `contributes.ui`. Reads JSON only
 * and never runs plugin code, so it is safe before a community package is
 * approved. A spec that cannot be shown becomes a diagnostic; the package's
 * other panels still load.
 */
export async function loadPluginUiSpecs(
  root: string,
  pluginId: string,
  ui: Partial<Record<PluginUiSlot, readonly string[]>> | undefined,
): Promise<PluginUiSpecs> {
  const slots: Partial<
    Record<PluginUiSlot, Readonly<Record<string, unknown>>[]>
  > = {};
  const diagnostics: PluginUiSpecDiagnostic[] = [];
  for (const slot of ["right", "message"] as const)
    for (const [specIndex, declaredPath] of (ui?.[slot] ?? []).entries()) {
      try {
        if (!declaredPath.endsWith(".json"))
          throw new PluginUiSpecError([
            {
              path: "(root)",
              message:
                "custom component files are not supported; declare a JSON UI spec with a view or webview",
            },
          ]);
        const spec = await loadPluginUiSpec(
          root,
          path.resolve(root, declaredPath),
          pluginId,
        );
        (slots[slot] ??= []).push(spec);
      } catch (error) {
        diagnostics.push({
          slot,
          specIndex,
          declaredPath,
          ...(error instanceof PluginUiSpecError && error.specId
            ? { specId: error.specId }
            : {}),
          issues:
            error instanceof PluginUiSpecError
              ? error.issues
              : [{ path: "(root)", message: readProblem(error, declaredPath) }],
        });
      }
    }
  return { slots, diagnostics };
}

/** Why a spec could not be read, without the host's directories in it. */
function readProblem(error: unknown, declaredPath: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return `${declaredPath} or the document it names does not exist`;
  if (code) return `cannot read ${declaredPath} (${code})`;
  if (error instanceof SyntaxError)
    return `${declaredPath} is not valid JSON: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
