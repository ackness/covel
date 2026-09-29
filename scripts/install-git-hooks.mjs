import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const marker = "# Covel managed pre-push hook.";
const hook = `#!/bin/sh
${marker}
exec mise exec -- node scripts/check-push.mjs --pre-push "$@"
`;

try {
  const customHooks = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
  });
  if (customHooks.error) throw customHooks.error;
  if (customHooks.status !== 0 && customHooks.status !== 1) {
    throw new Error("Unable to inspect Git hook configuration.");
  }
  if (customHooks.status === 0) {
    throw new Error(
      "core.hooksPath is already configured. Install the pre-push command in your existing hook manager.",
    );
  }
  const target = execFileSync(
    "git",
    ["rev-parse", "--git-path", "hooks/pre-push"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (existsSync(target) && !readFileSync(target, "utf8").includes(marker)) {
    throw new Error(
      "An existing pre-push hook was found; it was not overwritten.",
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, hook, { encoding: "utf8", mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(
    "Installed automatic clean-checkout pre-push checks. Existing pre-commit hooks are unchanged.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
