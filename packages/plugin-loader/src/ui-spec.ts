import { PLUGIN_UI_COMPONENT_NAMES } from "@covel/shared";
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

/** Expand plugin-owned HTML documents; the browser runs them in an opaque sandbox. */
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
  validateUiBindings(spec, ownerPluginId);
  const webview = spec.webview;
  if (webview && typeof webview === "object" && !Array.isArray(webview)) {
    const { entry, height } = webview as Record<string, unknown>;
    if (typeof entry !== "string" || !entry.endsWith(".html"))
      throw new Error("webview.entry must reference a local .html document");
    const htmlPath = await containedFile(
      root,
      path.resolve(path.dirname(specPath), entry),
    );
    if ((await fs.stat(htmlPath)).size > 512 * 1024)
      throw new Error("Plugin UI document exceeds 512 KiB");
    spec.webview = {
      html: await fs.readFile(htmlPath, "utf-8"),
      ...(height === undefined ? {} : { height }),
    };
  }
  return spec;
}

/** Every plugin binding is literal and owned; cross-plugin data uses kernel views. */
export function validateUiBindings(
  value: unknown,
  ownerPluginId: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) validateUiBindings(item, ownerPluginId);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "dataSource" && item && typeof item === "object") {
      const bindings = (item as Record<string, unknown>).bindings;
      if (bindings !== undefined) {
        if (
          !bindings ||
          typeof bindings !== "object" ||
          Array.isArray(bindings) ||
          Object.keys(bindings).length > 8 ||
          Object.entries(bindings).some(
            ([name, namespace]) =>
              !/^[a-z][a-zA-Z0-9_]*$/.test(name) ||
              typeof namespace !== "string" ||
              !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(namespace),
          )
        )
          throw new Error(
            "UI dataSource.bindings must name explicit own namespaces",
          );
      }
    }
    if (
      ["pluginId", "sourcePlugin", "sourcePluginId"].includes(key) &&
      item !== ownerPluginId
    )
      throw new Error(
        `UI binding ${key} must reference its owning plugin ${ownerPluginId}`,
      );
    validateUiBindings(item, ownerPluginId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Static check of an authored UI spec: the parts of it that the app rejects or
 * silently renders empty. Throws `<JSON path>: <problem>; <what is expected>`
 * for the first one. The component vocabulary is closed: a package cannot
 * add a component, so a name outside `PLUGIN_UI_COMPONENT_NAMES` is an error.
 */
export function validateUiSpecStructure(spec: unknown): void {
  if (!isRecord(spec))
    throw new Error("(root): a UI spec must be a JSON object");
  const hasView = spec.view !== undefined && spec.view !== null;
  const hasWebview = spec.webview !== undefined && spec.webview !== null;
  if (hasView === hasWebview)
    throw new Error(
      `${hasView ? "webview" : "view"}: a UI spec declares either view or webview; ${hasView ? "remove one of them" : "add one of them"}`,
    );
  if (hasView) validateUiNode(spec.view, "view");
  validateItemPaths(spec, "");
}

function validateUiNode(node: unknown, at: string): void {
  if (!isRecord(node))
    throw new Error(`${at}: a UI node must be a JSON object`);
  const names = (["component", "type"] as const).filter(
    (field) => node[field] !== undefined,
  );
  if (names.length === 0)
    throw new Error(
      `${at}.component: a UI node needs a component; use a component name from docs/reference/ui-components.md`,
    );
  for (const field of names) {
    const name = node[field];
    if (
      typeof name !== "string" ||
      !(PLUGIN_UI_COMPONENT_NAMES as readonly string[]).includes(name)
    )
      throw new Error(
        `${at}.${field}: unknown component ${typeof name === "string" ? name : JSON.stringify(name)}; use a component name from docs/reference/ui-components.md`,
      );
  }
  if (
    node.component !== undefined &&
    node.type !== undefined &&
    node.component !== node.type
  )
    throw new Error(
      `${at}.type: component and type name different components; keep component only`,
    );
  if (node.repeat !== undefined) {
    const statePath = isRecord(node.repeat) ? node.repeat.statePath : undefined;
    const absolute = typeof statePath === "string" && statePath.startsWith("/");
    const relative =
      isRecord(statePath) &&
      typeof statePath.$item === "string" &&
      Object.keys(statePath).length === 1;
    if (!absolute && !relative)
      throw new Error(
        `${at}.repeat.statePath: must be an absolute state path string such as "/entries", or { "$item": "field" } inside another repeat`,
      );
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children))
      throw new Error(`${at}.children: must be an array of UI nodes`);
    for (const [index, child] of node.children.entries())
      validateUiNode(child, `${at}.children[${index}]`);
  }
  if (node.slots !== undefined) {
    if (!isRecord(node.slots))
      throw new Error(
        `${at}.slots: must be an object of slot name to an array of UI nodes`,
      );
    for (const [slot, children] of Object.entries(node.slots)) {
      if (!Array.isArray(children))
        throw new Error(`${at}.slots.${slot}: must be an array of UI nodes`);
      for (const [index, child] of children.entries())
        validateUiNode(child, `${at}.slots.${slot}[${index}]`);
    }
  }
}

/** `$item` / `$bindItem` name a field of the current item, never a state path. */
function validateItemPaths(value: unknown, at: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      validateItemPaths(item, `${at}[${index}]`);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const child = at ? `${at}.${key}` : key;
    if (
      (key === "$item" || key === "$bindItem") &&
      typeof item === "string" &&
      item.startsWith("/")
    )
      throw new Error(
        `${child}: ${JSON.stringify(item)} must not start with a slash; write the item's field name (${JSON.stringify(item.slice(1))})`,
      );
    validateItemPaths(item, child);
  }
}
