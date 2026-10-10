/**
 * The manual steps of the release checklist (docs/guide/desktop-packaging.md):
 * the framework version in the root, `apps/*` and `packages/*` manifests, the
 * version badge of both READMEs, and the changelog assembly. Plugins and worlds
 * version independently and are left alone.
 *
 * `prepareRelease` reads and writes files under `root` and changes nothing when
 * `dryRun` is set. It makes no commit, tag or push. scripts/release-prepare.mjs
 * is the command.
 */
import fs from "node:fs";
import path from "node:path";
import { readFragments } from "../changelog.mjs";
import {
  CHANGELOG_PATH,
  FRAGMENT_DIR,
  assembleRelease,
} from "./changelog-fragments.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;
const VERSION_FIELD = /("version"\s*:\s*")([^"]+)(")/;
const BADGE =
  /(img\.shields\.io\/badge\/version-v)(\d+\.\d+\.\d+)(-[0-9a-f]{6}\)\]\(\.\/docs\/CHANGELOG\.md#)(\d+)(---)(\d{4}-\d{2}-\d{2})(\))/;
const SOURCE_VERSION = /(Source version: v|当前源码版本：v)(\d+\.\d+\.\d+)/;
const READMES = ["README.md", "README.zh-CN.md"];

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    if (value !== other) return value - other;
  }
  return 0;
}

/** The manifests that carry the framework version, as paths relative to `root`. */
export function frameworkManifests(root) {
  const manifests = ["package.json"];
  for (const group of ["apps", "packages"]) {
    const directory = path.join(root, group);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const manifest = path.join(group, entry.name, "package.json");
      if (entry.isDirectory() && fs.existsSync(path.join(root, manifest))) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}

/**
 * @param {string} root checkout to prepare
 * @param {{ version: string, date: string, dryRun?: boolean, isClean?: () => boolean }} options
 * @returns {{ changes: string[], notes: string[] }} what was (or would be) changed
 */
export function prepareRelease(
  root,
  { version, date, dryRun = false, isClean },
) {
  if (!VERSION.test(version ?? "")) {
    throw new Error(`"${version}" is not a version such as 0.0.50.`);
  }
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const current = rootManifest.version;
  if (compareVersions(version, current) < 0) {
    throw new Error(
      `${version} is lower than the current version ${current}; a release moves the version forward.`,
    );
  }
  const notes = [];
  if (isClean && !isClean()) {
    const message =
      "The working tree has uncommitted changes; commit or discard them first so the release change stands alone.";
    if (!dryRun) throw new Error(message);
    notes.push(`Would refuse: ${message}`);
  }

  const manifests = frameworkManifests(root);
  const manifestEdits = [];
  for (const relative of manifests) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    const match = VERSION_FIELD.exec(text);
    if (!match) throw new Error(`${relative} has no "version" field.`);
    if (match[2] !== version) {
      manifestEdits.push({
        relative,
        from: match[2],
        text: text.replace(VERSION_FIELD, `$1${version}$3`),
      });
    }
  }
  // The same version again is the re-run after a late changelog fragment:
  // allowed only once every manifest is already at it.
  if (version === current && manifestEdits.length > 0) {
    throw new Error(
      `${version} is the current version of the root manifest but ${manifestEdits.length} other manifest(s) differ; use a version greater than ${current}.`,
    );
  }

  const readmeEdits = [];
  const anchor = version.replaceAll(".", "");
  for (const relative of READMES) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    let next = text;
    if (!BADGE.test(next)) {
      throw new Error(`${relative}: the version badge was not found.`);
    }
    next = next.replace(
      BADGE,
      (match, a, old, b, oldAnchor, dash, oldDate, c) => {
        // The anchor keeps the date of the release the badge points at; a re-run
        // on the same version must not move it.
        const keep = old === version;
        return `${a}${version}${b}${keep ? oldAnchor : anchor}${dash}${keep ? oldDate : date}${c}`;
      },
    );
    if (!SOURCE_VERSION.test(next)) {
      throw new Error(`${relative}: the "Source version" line was not found.`);
    }
    next = next.replace(SOURCE_VERSION, `$1${version}`);
    if (next !== text) readmeEdits.push({ relative, text: next });
    for (const [index, line] of next.split("\n").entries()) {
      if (
        index > 0 &&
        line.startsWith(">") &&
        line.includes(`v${current}`) &&
        version !== current
      ) {
        notes.push(
          `${relative}:${index + 1} still names v${current} in its upgrade sentence; rewrite it for v${version}.`,
        );
      }
    }
  }

  const changelogFile = path.join(root, CHANGELOG_PATH);
  const changelog = fs.readFileSync(changelogFile, "utf8");
  const { fragments } = readFragments(root);
  const assembled = assembleRelease(changelog, fragments, { version, date });

  const changes = [];
  for (const edit of manifestEdits) {
    changes.push(`${edit.relative}: version ${edit.from} -> ${version}`);
  }
  for (const edit of readmeEdits) {
    changes.push(
      `${edit.relative}: version badge and source-version line -> v${version}`,
    );
  }
  if (assembled.moved > 0) {
    changes.push(
      `${CHANGELOG_PATH}: ${assembled.moved} entries moved under [${version}] - ${date}; ${fragments.length} fragment(s) in ${FRAGMENT_DIR}/ removed`,
    );
  }
  if (changes.length > 0) {
    notes.push(
      `Write the summary paragraph under the [${version}] heading and review the README upgrade sentence; then run the rest of the release checklist.`,
    );
  }

  if (!dryRun) {
    for (const edit of manifestEdits) {
      fs.writeFileSync(path.join(root, edit.relative), edit.text);
    }
    for (const edit of readmeEdits) {
      fs.writeFileSync(path.join(root, edit.relative), edit.text);
    }
    if (assembled.text !== changelog) {
      fs.writeFileSync(changelogFile, assembled.text);
    }
    for (const { name } of fragments) {
      fs.rmSync(path.join(root, FRAGMENT_DIR, name));
    }
  }
  return { changes, notes };
}
