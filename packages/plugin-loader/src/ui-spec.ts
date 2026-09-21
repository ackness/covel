import fs from "node:fs/promises";
import path from "node:path";

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
): Promise<Record<string, unknown>> {
  const specPath = await containedFile(root, file);
  const spec = JSON.parse(await fs.readFile(specPath, "utf-8")) as Record<
    string,
    unknown
  >;
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
