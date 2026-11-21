import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readPlainYamlFrontmatter } from "../../packages/plugin-loader/src/plain-yaml-frontmatter.ts";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".vitepress",
  "coverage",
  "build",
  "out",
]);

const GRAY_MATTER_IMPORT_RE =
  /(?:from\s+|(?:import|require)\s*\(\s*)["']gray-matter["']/;

async function collectSourceFiles(root, relativeDir, out) {
  const fullDir = path.join(root, relativeDir);
  for (const entry of await readdir(fullDir, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        await collectSourceFiles(root, relativePath, out);
      }
      continue;
    }
    if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(relativePath);
    }
  }
}

test("an empty translated header leaves later Markdown rules in the body", () => {
  const body = "Translated prompt\n\n---\nSecond section\n";
  assert.deepEqual(readPlainYamlFrontmatter(`---\n---\n${body}`), {
    data: {},
    body,
  });
  assert.deepEqual(readPlainYamlFrontmatter("---\n---"), {
    data: {},
    body: "",
  });
  assert.deepEqual(readPlainYamlFrontmatter("---\n# comment only\n---\nBody"), {
    data: {},
    body: "Body",
  });
});

test("preserves BOM, CRLF body, and later horizontal rules in non-empty headers", () => {
  const content = "\uFEFF---\r\nid: demo\r\n---\r\nBody\r\n\r\n---\r\nMore\r\n";
  assert.deepEqual(readPlainYamlFrontmatter(content), {
    data: { id: "demo" },
    body: "Body\r\n\r\n---\r\nMore\r\n",
  });
});

test("rejects executable directives and unclosed envelopes", () => {
  for (const engine of ["js", "javascript", "json", "yaml", "coffee"]) {
    assert.throws(
      () => readPlainYamlFrontmatter(`---${engine}\nid: demo\n---\nBody`),
      /plain YAML frontmatter/,
    );
  }
  assert.throws(
    () => readPlainYamlFrontmatter("---\nid: demo\n"),
    /plain YAML frontmatter/,
  );
  assert.throws(
    () => readPlainYamlFrontmatter("plain text without frontmatter"),
    /plain YAML frontmatter/,
  );
});

test("rejects non-object YAML frontmatter roots, unresolved tags, and multi-doc streams", () => {
  for (const sample of [
    "---\nhello\n---\nBody",
    "---\n42\n---\nBody",
    "---\ntrue\n---\nBody",
    "---\n- a\n- b\n---\nBody",
  ]) {
    assert.throws(() => readPlainYamlFrontmatter(sample), /YAML mapping/);
  }
  assert.throws(
    () =>
      readPlainYamlFrontmatter(
        '---\na: !<tag:yaml.org,2002:js/function> "function(){}"\n---\nBody',
      ),
    /Unresolved tag/,
  );
  assert.throws(
    () => readPlainYamlFrontmatter("---\na: 1\n...\nb: 2\n---\nBody"),
    /single YAML document/,
  );
});

test("rejects YAML alias bombs (Billion Laughs expansion)", () => {
  const bomb = [
    "---",
    "a: &a [x, x]",
    "b: &b [*a, *a]",
    "c: &c [*b, *b]",
    "d: &d [*c, *c]",
    "e: &e [*d, *d]",
    "f: &f [*e, *e]",
    "g: &g [*f, *f]",
    "h: &h [*g, *g]",
    "i: &i [*h, *h]",
    "j: &j [*i, *i]",
    "---",
    "Body",
  ].join("\n");

  assert.throws(() => readPlainYamlFrontmatter(bomb), /alias/i);
});

test("no source file in packages, apps, or scripts imports gray-matter", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const files = [];
  for (const directory of ["packages", "apps", "scripts"]) {
    await collectSourceFiles(root, directory, files);
  }
  const imports = [];
  for (const relativePath of files) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    if (GRAY_MATTER_IMPORT_RE.test(source)) {
      imports.push(relativePath);
    }
  }
  assert.deepEqual(imports, []);
});
