// Validate relative internal Markdown `#anchor` links across docs/ against
// target headings (using VitePress's githubSlug rule) and explicit anchors.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const docsRoot = path.join(root, "docs");

// Mirrors `githubSlug` in `apps/docs/.vitepress/config.ts`.
function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function collectMarkdownFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const rel = path.relative(docsRoot, full).split(path.sep).join("/");
    if (rel === "CHANGELOG.md" || rel === "changelog.d") continue;
    if (statSync(full).isDirectory()) {
      found.push(...collectMarkdownFiles(full));
    } else if (name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Strip fenced code blocks (preserving line count so reported line numbers
 * match the source file) and return an array of lines outside fences.
 */
function stripFencedCodeLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let activeFence = null;
  for (const line of lines) {
    const trimmed = line.replace(/^\s{0,3}(?:>\s*)*/, "");
    if (!activeFence) {
      const open = /^(`{3,}|~{3,})/.exec(trimmed);
      if (open) {
        activeFence = { char: open[1][0], length: open[1].length };
        out.push("");
        continue;
      }
      out.push(line);
    } else {
      const close = new RegExp(
        `^${activeFence.char}{${activeFence.length},}\\s*$`,
      );
      if (close.test(trimmed)) activeFence = null;
      out.push("");
    }
  }
  return out;
}

/** Remove inline code spans so backticked examples are not parsed as links/HTML. */
function stripInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?)\1/g, (match) => " ".repeat(match.length));
}

/** Reduce Markdown inline formatting in a heading to the rendered plain text. */
function headingPlainText(raw) {
  const codeSpans = [];
  const withPlaceholders = raw.replace(/`([^`]*)`/g, (_, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(code);
    return token;
  });
  const stripped = withPlaceholders
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|~~)(.*?)\1/g, "$2")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, "$1");
  return stripped
    .replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)] ?? "")
    .trim();
}

function extractAnchorsFromText(text) {
  const lines = stripFencedCodeLines(text);
  const anchors = new Set();
  const slugCounts = new Map();

  for (const line of lines) {
    const clean = stripInlineCode(line);

    // Explicit HTML anchors such as `<a id="legacy-anchor"></a>`.
    for (const match of clean.matchAll(
      /<a\b[^>]*\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
    )) {
      const id = match[1] ?? match[2];
      if (id) anchors.add(id);
    }

    // ATX headings (with optional `{#custom-id}` suffix).
    const headingMatch = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!headingMatch) continue;
    let body = headingMatch[1];

    const customMatch = /\s*\{#([^}\s]+)\}\s*$/.exec(body);
    if (customMatch) {
      anchors.add(customMatch[1]);
      body = body.slice(0, customMatch.index);
    }

    const base = githubSlug(headingPlainText(body));
    if (!base) continue;

    const count = slugCounts.get(base) ?? 0;
    if (count === 0 && !anchors.has(base)) {
      anchors.add(base);
      slugCounts.set(base, 1);
    } else {
      let suffix = Math.max(count, 1);
      while (anchors.has(`${base}-${suffix}`)) suffix++;
      anchors.add(`${base}-${suffix}`);
      slugCounts.set(base, suffix + 1);
    }
  }

  return anchors;
}

function extractAnchors(filePath) {
  return extractAnchorsFromText(readFileSync(filePath, "utf8"));
}

/** Extract `[label](target)` and `[ref]: target` links that carry a `#fragment`. */
function extractFragmentLinksFromText(text) {
  const lines = stripFencedCodeLines(text);
  const links = [];

  for (let index = 0; index < lines.length; index++) {
    const clean = stripInlineCode(lines[index]);
    const lineNo = index + 1;

    // Inline Markdown links (skip images `![...]`).
    const inlinePattern =
      /(?<!!)\[(?:[^\]\\]|\\.|\[[^\]]*\])*\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
    for (const match of clean.matchAll(inlinePattern)) {
      const href = match[1].replace(/^<|>$/g, "");
      if (href.includes("#")) links.push({ lineNo, href });
    }

    // Reference link definitions `[id]: target`.
    const refMatch = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(clean);
    if (refMatch && refMatch[1].includes("#")) {
      links.push({ lineNo, href: refMatch[1] });
    }
  }

  return links;
}

function extractFragmentLinks(filePath) {
  return extractFragmentLinksFromText(readFileSync(filePath, "utf8"));
}

function decodeFragment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

test("anchor parser matches VitePress githubSlug, explicit anchors, duplicates, and ignores fenced/inline code", () => {
  const sample = [
    "## Game Master Panel (`dm-console`)",
    "### 子 agent（delegate）",
    "### 语言文件（`<name>.<locale>.<ext>`）",
    "### Duplicate",
    "### Duplicate",
    '<a id="legacy-anchor"></a>',
    "### Custom Heading {#custom-id}",
    "```markdown",
    "## Ignored Heading",
    "[ignored](./missing.md#ignored)",
    "```",
    "Inline `[ignored](./missing.md#inline)` and [real](./other.md#target).",
  ].join("\n");

  const anchors = extractAnchorsFromText(sample);
  assert.ok(anchors.has("game-master-panel-dm-console"));
  assert.ok(anchors.has("子-agentdelegate"));
  assert.ok(anchors.has("语言文件namelocaleext"));
  assert.ok(anchors.has("duplicate"));
  assert.ok(anchors.has("duplicate-1"));
  assert.ok(anchors.has("legacy-anchor"));
  assert.ok(anchors.has("custom-id"));
  assert.equal(anchors.has("ignored-heading"), false);

  assert.deepEqual(extractFragmentLinksFromText(sample), [
    { lineNo: 12, href: "./other.md#target" },
  ]);
});

test("every relative internal #anchor link in docs/ resolves to a real heading or explicit anchor", () => {
  const files = collectMarkdownFiles(docsRoot);
  const anchorCache = new Map();
  const getAnchors = (targetPath) => {
    if (!anchorCache.has(targetPath)) {
      anchorCache.set(targetPath, extractAnchors(targetPath));
    }
    return anchorCache.get(targetPath);
  };

  const broken = [];
  for (const file of files) {
    const relSource = path.relative(root, file).split(path.sep).join("/");
    for (const { lineNo, href } of extractFragmentLinks(file)) {
      // Skip external URLs and site-root absolute links.
      if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) continue;

      const hashIndex = href.indexOf("#");
      const rawTarget = href.slice(0, hashIndex);
      const rawFragment = href.slice(hashIndex + 1);
      if (!rawFragment) continue;

      const targetPath = rawTarget
        ? path.resolve(path.dirname(file), rawTarget)
        : file;

      // Only validate Markdown targets (skip code line links like foo.ts#L10).
      if (!targetPath.endsWith(".md")) continue;

      const relTarget = path
        .relative(root, targetPath)
        .split(path.sep)
        .join("/");
      if (!existsSync(targetPath)) {
        broken.push(
          `${relSource}:${lineNo}: target file missing for ${href} (${relTarget})`,
        );
        continue;
      }

      const fragment = decodeFragment(rawFragment);
      const anchors = getAnchors(targetPath);
      if (!anchors.has(fragment) && !anchors.has(rawFragment)) {
        broken.push(
          `${relSource}:${lineNo}: broken anchor #${fragment} in ${relTarget} (from ${href})`,
        );
      }
    }
  }

  assert.deepEqual(broken, []);
});
