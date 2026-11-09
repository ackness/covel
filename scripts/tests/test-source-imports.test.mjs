import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isProductionFile,
  testSourceImportErrors,
} from "../lib/test-source-imports.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "covel-test-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const workspace = (group, name) => ({
    group,
    name,
    directory: path.join(root, group, name),
    manifest: { name: `@covel/${name}` },
  });
  const workspaces = [
    workspace("apps", "server"),
    workspace("packages", "store"),
    workspace("plugins", "dice"),
  ];
  write("packages/store/src/internal.ts", "export const value = 1;");
  write("plugins/dice/handler.js", "export default {};");
  return {
    root,
    workspaces,
    write,
    check: (allowlist) => testSourceImportErrors(root, workspaces, allowlist),
  };
}

test("rejects relative imports and mocks into another workspace from tests", (t) => {
  const probe = fixture(t);
  probe.write(
    "apps/server/tests/store.test.ts",
    `import { value } from "../../../packages/store/src/internal.js";
     vi.mock("../../../packages/store/src/internal.js");`,
  );
  const errors = probe.check().sort();
  assert.equal(errors.length, 2);
  assert.match(errors[0], /imports a file of @covel\/store by relative path/);
  assert.match(errors[1], /mocks a file of @covel\/store by relative path/);
});

test("allows package entries, own files, plugin modules and listed exceptions", (t) => {
  const probe = fixture(t);
  probe.write(
    "apps/server/tests/ok.test.ts",
    `import { value } from "@covel/store/testing";
     import { local } from "../src/local.js";
     import dice from "../../../plugins/dice/handler.js";`,
  );
  probe.write(
    "apps/server/tests/listed.test.ts",
    'import "../../../packages/store/src/internal.js";',
  );
  // Production source is the boundary scan's job, not this check's.
  probe.write(
    "apps/server/src/main.ts",
    'import "../../../packages/store/src/internal.js";',
  );
  assert.deepEqual(
    probe.check([
      {
        from: "apps/server/tests/listed.test.ts",
        imports: ["packages/store/src/internal.js"],
        reason: "Probe exception",
      },
    ]),
    [],
  );
});

test("rejects stale and unexplained allowlist entries", (t) => {
  const probe = fixture(t);
  const errors = probe.check([
    {
      from: "apps/server/tests/gone.test.ts",
      imports: ["packages/store/src/internal.js"],
      reason: " ",
    },
  ]);
  assert.ok(
    errors.some((error) => error.includes("needs imports and a reason")),
  );
  assert.ok(errors.some((error) => error.includes("stale test import")));
});

test("classifies production files like the boundary scan", (t) => {
  const probe = fixture(t);
  const [server, , dice] = probe.workspaces;
  const at = (workspace, file) => path.join(workspace.directory, file);
  assert.equal(isProductionFile(server, at(server, "src/main.ts")), true);
  assert.equal(
    isProductionFile(server, at(server, "src/x/__tests__/a.ts")),
    false,
  );
  assert.equal(isProductionFile(server, at(server, "src/a.test.ts")), false);
  assert.equal(isProductionFile(server, at(server, "vitest.config.ts")), false);
  assert.equal(isProductionFile(dice, at(dice, "handler.js")), true);
  assert.equal(isProductionFile(dice, at(dice, "tests/a.test.js")), false);
});
