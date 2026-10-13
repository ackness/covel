/** Development reload: give one plugin a fresh module graph per generation. */
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reload generation → the plugin directories (as given and resolved) it may re-import from. */
const generationRoots = new Map<string, readonly string[]>();
let hooksInstalled = false;

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The versioned URL of a relative import made by a module of a tracked
 * generation, or `undefined` when the import keeps its ordinary identity.
 *
 * Only a relative ES module import that resolves inside the plugin's own
 * directory is versioned. Packages, `node_modules`, CommonJS and native files
 * stay shared, so a reload never duplicates the SDK or host code.
 */
export function reloadGenerationUrl(
  specifier: string,
  parentUrl: string | undefined,
  resolvedUrl: string,
): string | undefined {
  if (!parentUrl?.startsWith("file:") || !resolvedUrl.startsWith("file:"))
    return undefined;
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    return undefined;
  const generation = new URL(parentUrl).searchParams.get("generation");
  const roots = generation ? generationRoots.get(generation) : undefined;
  if (!generation || !roots) return undefined;
  const url = new URL(resolvedUrl);
  const target = fileURLToPath(url);
  if (
    target.split(path.sep).includes("node_modules") ||
    [".cjs", ".node"].includes(path.extname(target))
  )
    return undefined;
  if (!roots.some((root) => isInside(root, target))) return undefined;
  url.searchParams.set("generation", generation);
  return url.href;
}

/**
 * Make the modules that a plugin's entry, handlers and guards import
 * relatively reload together with them.
 *
 * The loader imports those direct modules with `?generation=<id>`. After this
 * call, a relative import made from a module of that generation carries the
 * same query, so the whole graph inside `rootPath` is evaluated again. Only a
 * development reload calls this: a generation that was never tracked (startup,
 * production, bundled plugins) resolves exactly as Node resolves it.
 *
 * Node keeps every evaluated module for the life of the process, so each
 * reload adds one copy of the plugin's modules; only a restart frees them.
 */
export function trackReloadGeneration(
  generation: string,
  rootPath: string,
): void {
  const resolved = path.resolve(rootPath);
  let real = resolved;
  try {
    // Node resolves imports to real paths; a linked plugin directory differs.
    real = fs.realpathSync(resolved);
  } catch {
    // A missing directory fails later, where the modules are imported.
  }
  generationRoots.set(generation, [...new Set([resolved, real])]);
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const url = reloadGenerationUrl(specifier, context.parentURL, result.url);
      return url ? { ...result, url } : result;
    },
  });
}
