import { build } from "esbuild";
import path from "node:path";

/** Shared main/preload recipe for development and packaged builds. */
export function bundleDesktopEntry(desktopRoot, entry, options = {}) {
  return build({
    absWorkingDir: desktopRoot,
    entryPoints: [path.join(desktopRoot, `src/${entry}.ts`)],
    bundle: true,
    outfile: path.join(desktopRoot, `dist/${entry}.mjs`),
    // Sandboxed preload executes synchronously through Electron's CJS loader.
    format: entry === "main" ? "esm" : "cjs",
    ...(entry === "main" && {
      // Bundled CommonJS dependencies still require Node builtins.
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    }),
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["electron"],
    ...options,
  });
}
