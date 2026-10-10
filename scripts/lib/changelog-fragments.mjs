/**
 * Changelog fragments.
 *
 * A change adds one file under `docs/changelog.d/` instead of a line in
 * `docs/CHANGELOG.md`, so two pull requests never edit the same lines. A
 * fragment is the Markdown that would have gone under `[Unreleased]`: one or
 * more `### <Section>` headings, each followed by list items. At release the
 * fragments are put under the new version's heading and deleted.
 *
 * Everything here works on text; scripts/changelog.mjs reads and writes files.
 */

/** Section names, in the order a release lists them. */
export const SECTIONS = [
  "Breaking",
  "Added",
  "Changed",
  "Removed",
  "Fixed",
  "Security",
  "Documentation",
  "Upgrade notes",
];

export const FRAGMENT_DIR = "docs/changelog.d";
export const CHANGELOG_PATH = "docs/CHANGELOG.md";

/**
 * While this comment stands under `[Unreleased]`, entries written there before
 * fragments existed are accepted. The first release made with the assembler
 * drops it, and from then on `[Unreleased]` must hold no entry.
 */
export const LEGACY_MARKER = "<!-- changelog:legacy-entries";

const UNRELEASED_NOTE =
  "Entries for the next release are in [`changelog.d/`](./changelog.d/README.md), one file per change; do not add lines here. `pnpm changelog:preview` prints them as this section.";

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

/** Whether a file name in the fragment directory is a fragment. */
export function isFragmentName(name) {
  return name !== "README.md" && name.endsWith(".md");
}

// A released section may carry the version in two headings so that links to
// them stay unique in the file.
const RELEASED_HEADINGS = {
  Breaking: (version) => `Breaking changes in v${version}`,
  "Upgrade notes": (version) => `Upgrade notes for v${version}`,
};

function releasedHeading(section, version) {
  return RELEASED_HEADINGS[section]?.(version) ?? section;
}

function canonicalSection(heading, version) {
  if (SECTIONS.includes(heading)) return heading;
  if (version === undefined) return undefined;
  return SECTIONS.find(
    (section) => releasedHeading(section, version) === heading,
  );
}

/**
 * Splits the lines under a `##` heading into the text before the first `###`
 * heading and the list items of each section. An item is a line that starts
 * with `- ` and the lines up to the next one.
 */
function parseBlock(lines, version) {
  const intro = [];
  const sections = new Map();
  const unknown = [];
  let items;
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const section = canonicalSection(heading[1], version);
      if (!section) unknown.push(heading[1]);
      // Text under an unknown heading is kept with the heading as one item.
      const name = section ?? heading[1];
      items = sections.get(name) ?? [];
      sections.set(name, items);
      continue;
    }
    if (!items) intro.push(line);
    else if (line.startsWith("- ") || items.length === 0) {
      if (line.trim() !== "") items.push(line);
    } else {
      items[items.length - 1] += `\n${line}`;
    }
  }
  for (const [name, list] of sections) {
    sections.set(
      name,
      list.map((item) => item.trimEnd()),
    );
  }
  return { intro: intro.join("\n").trim(), sections, unknown };
}

/**
 * Parses one fragment. Returns its entries by section and the reasons it is
 * not valid; an invalid fragment has no usable entries.
 */
export function parseFragment(text, name) {
  const errors = [];
  if (!FRAGMENT_NAME.test(name)) {
    errors.push(
      "the file name must be lower-case letters, digits and hyphens with the extension .md",
    );
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s/.test(line) && !/^###\s+\S/.test(line)) {
      errors.push(
        `line ${index + 1}: a heading must be "### <Section>", found "${line.trim()}"`,
      );
    }
  }
  const { intro, sections, unknown } = parseBlock(lines);
  if (intro !== "") {
    errors.push(
      'text before the first "### <Section>" heading belongs to no section',
    );
  }
  for (const heading of unknown) {
    errors.push(
      `unknown section "${heading}"; use one of: ${SECTIONS.join(", ")}`,
    );
  }
  if (sections.size === 0) errors.push("the fragment has no section");
  for (const [section, items] of sections) {
    if (items.length === 0) errors.push(`section "${section}" has no entry`);
    for (const item of items) {
      if (!/^-(?:\s|$)/.test(item)) {
        errors.push(
          `section "${section}": an entry is a list item that starts with "- ", found "${item.split("\n", 1)[0]}"`,
        );
      } else if (item.slice(1).trim() === "") {
        errors.push(`section "${section}" has an empty list item`);
      }
    }
  }
  // Changelog entries are English (AGENTS.md, Language).
  if (/\p{Script=Han}/u.test(text)) {
    errors.push("entries are written in English");
  }
  return { sections: errors.length === 0 ? sections : new Map(), errors };
}

/** Locates a `## [name]` block: the heading line and the lines up to the next. */
function findBlock(lines, name) {
  const start = lines.findIndex((line) => line.startsWith(`## [${name}]`));
  if (start === -1) return undefined;
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ["),
  );
  if (end === -1) end = lines.length;
  return { start, end };
}

function mergeInto(target, sections) {
  for (const [section, items] of sections) {
    target.set(section, [...(target.get(section) ?? []), ...items]);
  }
  return target;
}

/** Entries of every fragment, in file-name order. `fragments` is `[{ name, text }]`. */
export function collectFragments(fragments) {
  const sections = new Map();
  const errors = [];
  const sorted = [...fragments].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const { name, text } of sorted) {
    const parsed = parseFragment(text, name);
    for (const error of parsed.errors) {
      errors.push(`${FRAGMENT_DIR}/${name}: ${error}`);
    }
    mergeInto(sections, parsed.sections);
  }
  return { sections, errors };
}

function renderSections(sections, version) {
  const parts = [];
  for (const section of SECTIONS) {
    const items = sections.get(section);
    if (!items || items.length === 0) continue;
    const heading =
      version === undefined ? section : releasedHeading(section, version);
    parts.push(`### ${heading}\n\n${items.join("\n")}`);
  }
  return parts.join("\n\n");
}

function count(sections) {
  let total = 0;
  for (const items of sections.values()) total += items.length;
  return total;
}

export function unreleasedEntriesError(legacy) {
  return `${CHANGELOG_PATH}: [Unreleased] holds ${legacy} entr${legacy === 1 ? "y" : "ies"}. Put each in a file under ${FRAGMENT_DIR}/ (see ${FRAGMENT_DIR}/README.md); the release script writes this section.`;
}

/**
 * What is waiting for the next release: the entries still written under
 * `[Unreleased]`, then the fragments. `errors` lists everything that keeps it
 * from being assembled.
 */
export function pendingEntries(changelog, fragments) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const block = findBlock(lines, "Unreleased");
  const errors = [];
  if (!block) {
    errors.push(`${CHANGELOG_PATH}: no "## [Unreleased]" heading`);
    return { sections: new Map(), errors, legacy: 0, fragments: 0 };
  }
  const unreleased = parseBlock(lines.slice(block.start + 1, block.end));
  for (const heading of unreleased.unknown) {
    errors.push(
      `${CHANGELOG_PATH}: unknown section "${heading}" under [Unreleased]`,
    );
  }
  const legacy = count(unreleased.sections);
  const collected = collectFragments(fragments);
  errors.push(...collected.errors);
  return {
    sections: mergeInto(unreleased.sections, collected.sections),
    errors,
    legacy,
    // Entries under [Unreleased] are accepted only while the marker stands.
    legacyAllowed: unreleased.intro.includes(LEGACY_MARKER),
    fragments: count(collected.sections),
  };
}

/** The `[Unreleased]` section as it would read with every fragment in it. */
export function renderPreview(changelog, fragments) {
  const pending = pendingEntries(changelog, fragments);
  const body = renderSections(pending.sections);
  return `## [Unreleased]\n\n${body === "" ? "No pending entries." : body}\n`;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Moves the pending entries under `## [version] - date` and leaves
 * `[Unreleased]` empty. Entries are added to a section for that version when
 * the file already has one, so a second run after a late fragment adds to the
 * same release, and a run with nothing pending changes nothing.
 *
 * Returns the new changelog text and how many entries moved.
 */
export function assembleRelease(changelog, fragments, { version, date }) {
  if (!VERSION.test(version ?? "")) {
    throw new Error(`"${version}" is not a version such as 0.0.50.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    throw new Error(`"${date}" is not a date such as 2026-10-11.`);
  }
  const pending = pendingEntries(changelog, fragments);
  if (pending.errors.length > 0) throw new Error(pending.errors.join("\n"));

  const moved = count(pending.sections);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const unreleased = findBlock(lines, "Unreleased");
  const before = lines.slice(0, unreleased.start);
  let rest = lines.slice(unreleased.end);

  let intro = "";
  const sections = new Map();
  const existing = findBlock(rest, version);
  let heading = `## [${version}] - ${date}`;
  if (existing) {
    if (existing.start !== 0) {
      throw new Error(
        `${CHANGELOG_PATH}: [${version}] is not the newest release; entries are added to the release that follows [Unreleased].`,
      );
    }
    heading = rest[0];
    const parsed = parseBlock(rest.slice(1, existing.end), version);
    if (parsed.unknown.length > 0) {
      throw new Error(
        `${CHANGELOG_PATH}: unknown section "${parsed.unknown[0]}" under [${version}]`,
      );
    }
    intro = parsed.intro;
    mergeInto(sections, parsed.sections);
    rest = rest.slice(existing.end);
  } else if (moved === 0) {
    throw new Error(
      `Nothing to release: [Unreleased] is empty and ${FRAGMENT_DIR}/ has no fragment.`,
    );
  }
  mergeInto(sections, pending.sections);

  const release = [heading, intro, renderSections(sections, version)]
    .filter((part) => part !== "")
    .join("\n\n");
  const text = [
    before.join("\n").trimEnd(),
    `## [Unreleased]\n\n${UNRELEASED_NOTE}`,
    release,
    rest.join("\n").trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return { text: `${text}\n`, moved };
}
