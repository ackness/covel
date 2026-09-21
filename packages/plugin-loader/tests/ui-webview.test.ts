import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginUiSpec } from "../src/ui-spec.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
describe("plugin-owned UI documents", () => {
  it("loads a declared document without executing it and rejects traversal, symlinks and oversized files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-webview-"));
    dirs.push(root);
    const plugin = path.join(root, "plugin");
    await fs.mkdir(plugin);
    const html = "<script>throw new Error('must not run on server')</script>";
    await fs.writeFile(path.join(plugin, "view.html"), html);
    const spec = path.join(plugin, "panel.json");
    const write = async (entry: string) =>
      fs.writeFile(
        spec,
        JSON.stringify({
          id: "custom",
          webview: { entry, height: 200 },
          surfaces: ["stage"],
        }),
      );
    await write("./view.html");
    expect(await loadPluginUiSpec(plugin, spec)).toMatchObject({
      webview: { html, height: 200 },
      surfaces: ["stage"],
    });
    await fs.writeFile(path.join(root, "outside.html"), "private");
    await write("../outside.html");
    await expect(loadPluginUiSpec(plugin, spec)).rejects.toThrow("escapes");
    await fs.symlink(
      path.join(root, "outside.html"),
      path.join(plugin, "link.html"),
    );
    await write("./link.html");
    await expect(loadPluginUiSpec(plugin, spec)).rejects.toThrow("escapes");
    await fs.writeFile(path.join(plugin, "view.html"), "x".repeat(524289));
    await write("./view.html");
    await expect(loadPluginUiSpec(plugin, spec)).rejects.toThrow("512 KiB");
  });
});
