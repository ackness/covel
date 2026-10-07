import fs from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

/** Compile beside each source so import.meta.url keeps its resource geometry. */
export async function compileStagedServer(serverRoot) {
  const packageRoots = [serverRoot];
  const workspaceRoot = path.join(serverRoot, "node_modules/@covel");
  for (const entry of await fs.readdir(workspaceRoot, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory())
      packageRoots.push(path.join(workspaceRoot, entry.name));
  }
  let compiled = 0;
  async function compileDirectory(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["tests", "__tests__", "node_modules"].includes(entry.name)) {
          await compileDirectory(filename);
        }
      } else if (
        entry.name.endsWith(".ts") &&
        !/\.(d|test|spec)\.ts$/.test(entry.name)
      ) {
        const output = filename.replace(/\.ts$/, ".js");
        const { code } = await transform(await fs.readFile(filename, "utf8"), {
          loader: "ts",
          format: "esm",
          target: "node24",
          sourcefile: filename,
        });
        await fs.writeFile(output, code, "utf8");
        compiled++;
      }
    }
  }
  function runtimeExports(value, key) {
    if (key === "types") return value;
    if (typeof value === "string") return value.replace(/\.ts$/, ".js");
    if (Array.isArray(value))
      return value.map((entry) => runtimeExports(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([condition, entry]) => [
          condition,
          runtimeExports(entry, condition),
        ]),
      );
    }
    return value;
  }
  for (const packageRoot of packageRoots) {
    const source = path.join(packageRoot, "src");
    try {
      await fs.access(source);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    await compileDirectory(source);
    const manifestFile = path.join(packageRoot, "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (manifest.exports) manifest.exports = runtimeExports(manifest.exports);
    if (typeof manifest.main === "string")
      manifest.main = runtimeExports(manifest.main);
    await fs.writeFile(
      manifestFile,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  return compiled;
}
