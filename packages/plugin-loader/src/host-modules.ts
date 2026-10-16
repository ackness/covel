import { isPathInside } from "./path-containment.js";
/**
 * The packages a plugin may import without shipping them: the public plugin
 * SDK and `zod`, its peer. The host resolves them to its own copies for every
 * plugin module, bundled or installed, so a bundled plugin uses nothing an
 * installed one cannot. Every other bare import resolves as Node resolves it,
 * from the plugin's own directory.
 *
 * A plugin needs no `package.json`. Without one, the host loads the plugin's
 * `.js` files as ES modules, whatever a `package.json` in a directory above
 * the plugin says; with one, its `"type": "module"` decides as usual.
 */
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_MODULES = ["@covel/plugin-handlers-utils", "zod"] as const;

/** Host modules resolve as if this module imported them. */
export const HOST_MODULE_PARENT_URL = import.meta.url;

/** Plugin directories (as given and resolved) whose modules get host copies. */
const pluginRoots = new Set<string>();
let hooksInstalled = false;

/** Whether `specifier` names a host module or one of its subpaths. */
export function isHostModule(specifier: string): boolean {
  return HOST_MODULES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/** The plugin root that holds the module at `url`, if any. */
function pluginRootOf(url: string | undefined): string | undefined {
  if (!url?.startsWith("file:")) return undefined;
  const file = fileURLToPath(url);
  for (const root of pluginRoots) if (isPathInside(root, file)) return root;
  return undefined;
}

function isPluginModule(parentUrl: string | undefined): boolean {
  return pluginRootOf(parentUrl) !== undefined;
}

/** A `.js` file of a plugin that has no `package.json` of its own. */
function isPackageLessPluginScript(url: string): boolean {
  if (!url.startsWith("file:") || !fileURLToPath(url).endsWith(".js"))
    return false;
  const root = pluginRootOf(url);
  return root !== undefined && !fs.existsSync(path.join(root, "package.json"));
}

/**
 * Resolve the host modules for the plugin under `rootPath`. Call it before
 * importing the plugin's entry, handlers or guards; registering the same root
 * again does nothing.
 */
export function provideHostModules(rootPath: string): void {
  const resolved = path.resolve(rootPath);
  pluginRoots.add(resolved);
  try {
    // Node resolves imports to real paths; a linked plugin directory differs.
    pluginRoots.add(fs.realpathSync(resolved));
  } catch {
    // A missing directory fails later, where the modules are imported.
  }
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isHostModule(specifier) && isPluginModule(context.parentURL))
        // Resolve as if this host package imported it.
        return nextResolve(specifier, {
          ...context,
          parentURL: HOST_MODULE_PARENT_URL,
        });
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!isPackageLessPluginScript(url)) return nextLoad(url, context);
      const loaded = nextLoad(url, { ...context, format: "module" });
      return { ...loaded, format: "module" };
    },
  });
}
