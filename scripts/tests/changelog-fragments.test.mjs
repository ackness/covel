import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChangelog } from "../changelog.mjs";
import {
  LEGACY_MARKER,
  SECTIONS,
  assembleRelease,
  parseFragment,
  pendingEntries,
  renderPreview,
} from "../lib/changelog-fragments.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const command = fileURLToPath(new URL("../changelog.mjs", import.meta.url));

const HEAD = "# Changelog\n\nIntroduction.\n";
const RELEASED =
  "## [0.1.0] - 2026-01-01\n\nSummary of 0.1.0.\n\n### Fixed\n\n- **Old fix.** Text.\n";

function changelog(unreleased = "") {
  return `${HEAD}\n## [Unreleased]\n\n${unreleased}${unreleased ? "\n" : ""}${RELEASED}`;
}

const fragments = [
  {
    name: "b-second.md",
    text: "### Fixed\n\n- **B fix.** Text.\n\n### Breaking\n\n- **B break.** Text.\n  A second line of the same entry.\n",
  },
  {
    name: "a-first.md",
    text: "### Added\n\n- **A one.** Text.\n- **A two.** Text.\n\n### Fixed\n\n- **A fix.** Text.\n\n### Upgrade notes\n\n- **A note.** Text.\n",
  },
];

test("a fragment holds list items under known section headings", () => {
  const parsed = parseFragment(fragments[1].text, "a-first.md");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    [...parsed.sections],
    [
      ["Added", ["- **A one.** Text.", "- **A two.** Text."]],
      ["Fixed", ["- **A fix.** Text."]],
      ["Upgrade notes", ["- **A note.** Text."]],
    ],
  );
});

test("the example in the fragment guide is a valid fragment", () => {
  const guide = fs.readFileSync(
    path.join(repoRoot, "docs/changelog.d/README.md"),
    "utf8",
  );
  const example = /```markdown\n([\s\S]*?)```/.exec(guide)[1];
  const parsed = parseFragment(example, "example.md");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual([...parsed.sections.keys()], ["Breaking", "Added"]);
  // The guide lists every section the parser accepts.
  for (const section of SECTIONS) assert.ok(guide.includes(`\`${section}\``));
});

test("an invalid fragment is refused with the reason", () => {
  const cases = [
    ["### Improved\n\n- **X.** Text.\n", /unknown section "Improved"/],
    ["### Added\n\n### Fixed\n\n- **X.** Text.\n", /"Added" has no entry/],
    ["### Added\n", /"Added" has no entry/],
    ["", /no section/],
    ["- **X.** Text.\n", /before the first/],
    ["### Added\n\nA paragraph.\n", /an entry is a list item/],
    ["### Added\n\n- \n", /empty list item/],
    ["## Added\n\n- **X.** Text.\n", /a heading must be "### <Section>"/],
    ["### Added\n\n- **修复。** Text.\n", /English/],
  ];
  for (const [text, reason] of cases) {
    const { errors, sections } = parseFragment(text, "x.md");
    assert.match(errors.join("\n"), reason, text);
    assert.equal(sections.size, 0);
  }
  assert.match(
    parseFragment("### Added\n\n- **X.** Text.\n", "My Change.md").errors[0],
    /file name/,
  );
});

test("the preview lists sections in release order and fragments in file-name order", () => {
  assert.equal(
    renderPreview(changelog(), fragments),
    [
      "## [Unreleased]",
      "### Breaking",
      "- **B break.** Text.\n  A second line of the same entry.",
      "### Added",
      "- **A one.** Text.\n- **A two.** Text.",
      "### Fixed",
      "- **A fix.** Text.\n- **B fix.** Text.",
      "### Upgrade notes",
      "- **A note.** Text.",
      "",
    ]
      .join("\n\n")
      .trimEnd() + "\n",
  );
  assert.match(renderPreview(changelog(), []), /No pending entries/);
});

test("a release moves the entries under the version and empties [Unreleased]", () => {
  const { text, moved } = assembleRelease(changelog(), fragments, {
    version: "0.2.0",
    date: "2026-02-03",
  });
  assert.equal(moved, 6);
  assert.ok(
    text.startsWith(`${HEAD}\n## [Unreleased]\n\nEntries for the next`),
  );
  const released = text.slice(text.indexOf("## [0.2.0]"));
  assert.equal(
    released,
    [
      "## [0.2.0] - 2026-02-03",
      // The two headings other pages link to carry the version.
      "### Breaking changes in v0.2.0",
      "- **B break.** Text.\n  A second line of the same entry.",
      "### Added",
      "- **A one.** Text.\n- **A two.** Text.",
      "### Fixed",
      "- **A fix.** Text.\n- **B fix.** Text.",
      "### Upgrade notes for v0.2.0",
      "- **A note.** Text.",
      RELEASED,
    ].join("\n\n"),
  );
  // Nothing is pending afterwards.
  const after = pendingEntries(text, []);
  assert.equal(after.legacy + after.fragments, 0);
  assert.deepEqual(after.errors, []);
});

test("a second release run changes nothing, and a late fragment joins the same version", () => {
  const options = { version: "0.2.0", date: "2026-02-03" };
  const first = assembleRelease(changelog(), fragments, options);
  // The summary a person writes under the heading survives a later run.
  const edited = first.text.replace(
    "## [0.2.0] - 2026-02-03\n",
    "## [0.2.0] - 2026-02-03\n\nSummary of 0.2.0.\n",
  );
  const again = assembleRelease(edited, [], { ...options, date: "2026-02-09" });
  assert.equal(again.moved, 0);
  assert.equal(again.text, edited);

  const late = assembleRelease(
    edited,
    [{ name: "late.md", text: "### Fixed\n\n- **Late fix.** Text.\n" }],
    options,
  );
  assert.equal(late.moved, 1);
  assert.match(
    late.text,
    /Summary of 0\.2\.0\.\n\n### Breaking changes in v0\.2\.0\n/,
  );
  assert.match(
    late.text,
    /- \*\*B fix\.\*\* Text\.\n- \*\*Late fix\.\*\* Text\.\n/,
  );
  assert.equal(late.text.match(/## \[0\.2\.0\]/g).length, 1);
});

test("entries written under [Unreleased] before fragments are kept, ahead of the fragments", () => {
  const legacy = `${LEGACY_MARKER}: earlier entries -->\n\nPointer text.\n\n### Fixed\n\n- **Direct fix.** Text.\n\n### Removed\n\n- **Direct removal.** Text.\n`;
  const pending = pendingEntries(changelog(legacy), fragments);
  assert.deepEqual(pending.errors, []);
  assert.equal(pending.legacy, 2);
  assert.equal(pending.legacyAllowed, true);
  assert.equal(pending.fragments, 6);

  const { text } = assembleRelease(changelog(legacy), fragments, {
    version: "0.2.0",
    date: "2026-02-03",
  });
  assert.match(
    text,
    /### Removed\n\n- \*\*Direct removal\.\*\* Text\.\n\n### Fixed\n\n- \*\*Direct fix\.\*\* Text\.\n- \*\*A fix\.\*\* Text\.\n- \*\*B fix\.\*\* Text\.\n/,
  );
  // The transition ends with the release: the marker is gone.
  assert.equal(text.includes(LEGACY_MARKER), false);
  assert.equal(text.includes("Pointer text."), false);
});

test("a release refuses what it cannot place", () => {
  const options = { version: "0.2.0", date: "2026-02-03" };
  assert.throws(
    () => assembleRelease(changelog(), [], options),
    /Nothing to release/,
  );
  assert.throws(
    () =>
      assembleRelease(changelog(), fragments, { ...options, version: "next" }),
    /not a version/,
  );
  assert.throws(
    () =>
      assembleRelease(
        changelog(),
        [{ name: "x.md", text: "### Improved\n\n- **X.** Text.\n" }],
        options,
      ),
    /docs\/changelog\.d\/x\.md: unknown section/,
  );
  assert.throws(
    () =>
      assembleRelease(
        changelog("### Improved\n\n- **X.** Text.\n"),
        [],
        options,
      ),
    /unknown section "Improved" under \[Unreleased\]/,
  );
  // Only the newest release takes late entries.
  assert.throws(
    () =>
      assembleRelease(
        changelog().replace(RELEASED, `## [0.3.0] - 2026-03-01\n\n${RELEASED}`),
        fragments,
        { ...options, version: "0.1.0" },
      ),
    /not the newest release/,
  );
});

function checkout(t, { unreleased = "", files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-changelog-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs/changelog.d"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/CHANGELOG.md"), changelog(unreleased));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "docs/changelog.d", name), text);
  }
  return root;
}

test("the check accepts direct [Unreleased] entries only while the marker stands", (t) => {
  const entries = "### Fixed\n\n- **Direct fix.** Text.\n";
  const during = checkout(t, {
    unreleased: `${LEGACY_MARKER}: earlier entries -->\n\n${entries}`,
    files: { "README.md": "# Guide\n", "a.md": fragments[0].text },
  });
  assert.deepEqual(checkChangelog(during).errors, []);
  // At a tag nothing may wait.
  const atTag = checkChangelog(during, { noPending: true }).errors.join("\n");
  assert.match(
    atTag,
    /1 changelog fragment\(s\) and 1 \[Unreleased\] entries are not in a release/,
  );

  const after = checkout(t, { unreleased: entries });
  assert.match(
    checkChangelog(after).errors.join("\n"),
    /\[Unreleased\] holds 1 entry\. Put each in a file under docs\/changelog\.d/,
  );
  assert.deepEqual(checkChangelog(checkout(t)).errors, []);
});

test("the check names an invalid fragment and a file that is not one", (t) => {
  const root = checkout(t, {
    files: { "bad.md": "### Improved\n\n- **X.** Text.\n", "notes.txt": "x" },
  });
  const errors = checkChangelog(root).errors.join("\n");
  assert.match(
    errors,
    /docs\/changelog\.d\/bad\.md: unknown section "Improved"/,
  );
  assert.match(errors, /docs\/changelog\.d\/notes\.txt: only fragment files/);
});

test("the repository's fragments are valid and the commands run", () => {
  const check = spawnSync(process.execPath, [command, "check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  const preview = spawnSync(process.execPath, [command, "preview"], {
    encoding: "utf8",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^## \[Unreleased\]\n/);
  const usage = spawnSync(process.execPath, [command], { encoding: "utf8" });
  assert.equal(usage.status, 1);
});
