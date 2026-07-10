/**
 * electron@42 dropped its postinstall hook — the package declares no
 * lifecycle scripts at all (the download moved to an explicit
 * `install-electron` bin), so `pnpm install` never materialises the runtime
 * binary under node_modules/electron/dist and whitelisting electron in
 * `onlyBuiltDependencies` has nothing to run. Anything that needs the real
 * binary (dev shell, `--electron-node` staging smoke) calls this first.
 * install.js skips the download when dist/ is already present, so repeat
 * calls are cheap.
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export function ensureElectronBinary() {
  const electronDir = path.dirname(require.resolve("electron/package.json"));

  const resolveBinary = () => {
    const pathFile = path.join(electronDir, "path.txt");
    if (!fs.existsSync(pathFile)) return null;
    const binary = path.join(
      electronDir,
      "dist",
      fs.readFileSync(pathFile, "utf-8").trim(),
    );
    return fs.existsSync(binary) ? binary : null;
  };

  let binary = resolveBinary();
  if (binary) return binary;

  console.log(
    "[electron] runtime binary missing (electron@42+ has no postinstall) — downloading via install.js ...",
  );
  execFileSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
  });

  binary = resolveBinary();
  if (!binary) {
    throw new Error(
      `Electron binary still missing after install.js ran (looked under ${electronDir}/dist)`,
    );
  }
  return binary;
}
