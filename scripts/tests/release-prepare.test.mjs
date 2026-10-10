import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareRelease } from "../lib/release-prepare.mjs";

const BADGE_LINE = (version, anchor, date) =>
  `[![Version](https://img.shields.io/badge/version-v${version}-8b5cf6)](./docs/CHANGELOG.md#${anchor}---${date})`;
const README = (version, anchor, date) =>
  `# Covel\n\n${BADGE_LINE(version, anchor, date)}\n\n> **Source version: v${version}**, early access. Read the [v${version} upgrade notes](./docs/CHANGELOG.md).\n`;
const README_ZH = (version, anchor, date) =>
  `# Covel\n\n${BADGE_LINE(version, anchor, date)}\n\n> **当前源码版本：v${version}**，早期阶段。\n`;

function manifest(name, version) {
  return `${JSON.stringify({ name, version, private: true }, null, 2)}\n`;
}

/** A checkout with a root, two apps, two packages, a plugin and a world. */
function fixture({ version = "0.1.0", fragment = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  write("package.json", manifest("covel", version));
  for (const dir of [
    "apps/web",
    "apps/server",
    "packages/shared",
    "packages/store",
  ]) {
    write(`${dir}/package.json`, manifest(dir, version));
  }
  write("plugins/memory/package.json", manifest("plugin", "1.2.3"));
  write("worlds/x/package.json", manifest("world", "4.5.6"));
  write(
    "README.md",
    README(version, version.replaceAll(".", ""), "2026-01-01"),
  );
  write(
    "README.zh-CN.md",
    README_ZH(version, version.replaceAll(".", ""), "2026-01-01"),
  );
  write(
    "docs/CHANGELOG.md",
    `# Changelog\n\n## [Unreleased]\n\nEntries for the next release are in changelog.d.\n\n## [${version}] - 2026-01-01\n\n### Fixed\n\n- **Old fix.** Text.\n`,
  );
  write("docs/changelog.d/README.md", "# Fragments\n");
  if (fragment) {
    write(
      "docs/changelog.d/new-thing.md",
      "### Added\n\n- **New thing.** Text.\n",
    );
  }
  return root;
}

const read = (root, relative) =>
  fs.readFileSync(path.join(root, relative), "utf8");
const version = (root, relative) => JSON.parse(read(root, relative)).version;
const clean = () => true;

test("sets the framework version, the badges and the changelog, and leaves plugins and worlds", () => {
  const root = fixture();
  const { changes } = prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-03",
    isClean: clean,
  });
  for (const file of [
    "package.json",
    "apps/web/package.json",
    "apps/server/package.json",
    "packages/shared/package.json",
    "packages/store/package.json",
  ]) {
    assert.equal(version(root, file), "0.2.0", file);
  }
  assert.equal(version(root, "plugins/memory/package.json"), "1.2.3");
  assert.equal(version(root, "worlds/x/package.json"), "4.5.6");
  assert.match(
    read(root, "README.md"),
    /version-v0\.2\.0-8b5cf6\)\]\(\.\/docs\/CHANGELOG\.md#020---2026-02-03\)/,
  );
  assert.match(read(root, "README.md"), /Source version: v0\.2\.0\*\*/);
  assert.match(read(root, "README.zh-CN.md"), /当前源码版本：v0\.2\.0/);
  const changelog = read(root, "docs/CHANGELOG.md");
  assert.match(
    changelog,
    /## \[0\.2\.0\] - 2026-02-03\n\n### Added\n\n- \*\*New thing\.\*\*/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "docs/changelog.d/new-thing.md")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, "docs/changelog.d/README.md")),
    true,
  );
  assert.ok(changes.length >= 8);
});

test("a dry run reports the changes and writes nothing", () => {
  const root = fixture();
  const before = read(root, "docs/CHANGELOG.md");
  const { changes } = prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-03",
    dryRun: true,
    isClean: clean,
  });
  assert.ok(
    changes.some((line) =>
      line.startsWith("package.json: version 0.1.0 -> 0.2.0"),
    ),
  );
  assert.equal(version(root, "package.json"), "0.1.0");
  assert.equal(read(root, "docs/CHANGELOG.md"), before);
  assert.equal(
    fs.existsSync(path.join(root, "docs/changelog.d/new-thing.md")),
    true,
  );
});

test("refuses a lower version and a dirty tree", () => {
  const root = fixture();
  assert.throws(
    () =>
      prepareRelease(root, {
        version: "0.0.9",
        date: "2026-02-03",
        isClean: clean,
      }),
    /lower than the current version/,
  );
  assert.throws(
    () =>
      prepareRelease(root, {
        version: "0.2.0",
        date: "2026-02-03",
        isClean: () => false,
      }),
    /uncommitted changes/,
  );
  assert.equal(version(root, "package.json"), "0.1.0");
  const { notes } = prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-03",
    dryRun: true,
    isClean: () => false,
  });
  assert.match(notes.join("\n"), /Would refuse/);
});

test("refuses a version that is not a version", () => {
  const root = fixture();
  assert.throws(
    () =>
      prepareRelease(root, {
        version: "next",
        date: "2026-02-03",
        isClean: clean,
      }),
    /not a version/,
  );
});

test("the same version again adds a late fragment and keeps the badge date", () => {
  const root = fixture();
  prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-03",
    isClean: clean,
  });
  const once = read(root, "README.md");
  assert.deepEqual(
    prepareRelease(root, {
      version: "0.2.0",
      date: "2026-02-09",
      isClean: clean,
    }).changes,
    [],
  );
  fs.writeFileSync(
    path.join(root, "docs/changelog.d/late.md"),
    "### Fixed\n\n- **Late fix.** Text.\n",
  );
  const { changes } = prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-09",
    isClean: clean,
  });
  assert.equal(changes.length, 1);
  assert.equal(read(root, "README.md"), once);
  const changelog = read(root, "docs/CHANGELOG.md");
  assert.match(changelog, /## \[0\.2\.0\] - 2026-02-03/);
  assert.match(changelog, /Late fix/);
});

test("the same version with manifests that differ is refused", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "apps/web/package.json"),
    manifest("web", "0.0.1"),
  );
  assert.throws(
    () =>
      prepareRelease(root, {
        version: "0.1.0",
        date: "2026-02-03",
        isClean: clean,
      }),
    /other manifest\(s\) differ/,
  );
});

test("names a README sentence that still carries the earlier version", () => {
  const root = fixture();
  const { notes } = prepareRelease(root, {
    version: "0.2.0",
    date: "2026-02-03",
    dryRun: true,
    isClean: clean,
  });
  assert.match(notes.join("\n"), /README\.md:\d+ still names v0\.1\.0/);
});

test("nothing pending and no section for the version is an error", () => {
  const root = fixture({ fragment: false });
  assert.throws(
    () =>
      prepareRelease(root, {
        version: "0.2.0",
        date: "2026-02-03",
        isClean: clean,
      }),
    /Nothing to release/,
  );
  assert.equal(version(root, "package.json"), "0.1.0");
});
