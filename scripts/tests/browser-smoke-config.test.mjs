import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const configUrl = new URL(
  "../../tests/e2e/ci-smoke.config.ts",
  import.meta.url,
);

test("browser smoke starts each owned server once and respects external stacks", () => {
  for (const baseURL of [undefined, "http://127.0.0.1:5197"]) {
    const env = { ...process.env };
    if (baseURL) env.E2E_BASE_URL = baseURL;
    else delete env.E2E_BASE_URL;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import config from ${JSON.stringify(configUrl.href)};
         console.log(JSON.stringify(config.webServer ?? []));`,
      ],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const servers = JSON.parse(result.stdout);
    if (baseURL) {
      assert.deepEqual(servers, []);
    } else {
      assert.equal(servers.length, 2);
      assert.equal(new Set(servers.map((server) => server.url)).size, 2);
      assert.ok(servers.every((server) => server.cwd === repoRoot));
    }
  }
});
