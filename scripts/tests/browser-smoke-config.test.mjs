import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const servers = JSON.parse(result.stdout);
    if (baseURL) {
      assert.deepEqual(servers, []);
    } else {
      assert.equal(servers.length, 2);
      assert.equal(new Set(servers.map((server) => server.url)).size, 2);
      assert.ok(servers.every((server) => server.cwd === repoRoot));
      // The owned server runs in a home of its own, never the developer's:
      // a spec must not read installed plugins or keys, or leave a generated
      // world behind.
      const owned = servers.filter((server) => server.env?.COVEL_HOME);
      assert.equal(owned.length, 1);
      const home = owned[0].env.COVEL_HOME;
      assert.notEqual(path.resolve(home), path.join(os.homedir(), ".covel"));
      assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
      for (const key of ["COVEL_USER_WORLDS_DIR", "COVEL_USER_PLUGINS_DIR"]) {
        assert.equal(path.dirname(owned[0].env[key]), home, key);
      }
      assert.equal(fs.existsSync(home), false, "removed on exit");
    }
  }
});
