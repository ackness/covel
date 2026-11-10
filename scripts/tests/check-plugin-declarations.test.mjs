import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts/check-plugin-declarations.mjs");

function runCheck(plugins) {
  const repo = mkdtempSync(path.join(tmpdir(), "covel-declarations-"));
  try {
    for (const [id, files] of Object.entries(plugins)) {
      for (const [file, text] of Object.entries(files)) {
        const target = path.join(repo, "plugins", id, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
    }
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, "--root", repo],
      { cwd: root, encoding: "utf8" },
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const entry = `export default (covel) => {
  covel.registerRpc("roll", () => null);
  covel.provideExtension("prompt.segment@1", "notes", { handler: () => null });
};
`;
const manifest = (contributes) =>
  `---\ndescription: Fixture\n${contributes}---\n`;

test("a plugin whose declarations match its entry passes", () => {
  const result = runCheck({
    synced: {
      "PLUGIN.md": manifest(
        "contributes:\n  actions: [roll]\n  extensions: [prompt.segment@1/notes]\n",
      ),
      "server/index.js": entry,
    },
    declarative: { "PLUGIN.md": manifest("") },
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\(1 checked\)/);
});

test("drift is reported per key with the command that fixes it", () => {
  const result = runCheck({
    drifted: {
      "PLUGIN.md": manifest(
        "contributes:\n  actions: [roll, gone]\n  extensions: [prompt.segment@1/old]\n",
      ),
      "server/index.js": entry,
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /plugins\/drifted: PLUGIN\.md contributes is out of sync/,
  );
  assert.match(result.output, /- gone \(declared, not registered\)/);
  assert.match(
    result.output,
    /\+ prompt\.segment@1\/notes \(registered, not declared\)/,
  );
  assert.match(result.output, /- prompt\.segment@1\/old/);
  assert.match(result.output, /Fix: pnpm plugin:extract plugins\/drifted/);
});

test("an entry that cannot be extracted fails the check", () => {
  const result = runCheck({
    broken: {
      "PLUGIN.md": manifest(""),
      "server/index.js": "export default () => { throw new Error('boom'); };\n",
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /plugins\/broken: cannot extract registrations: boom/,
  );
});
