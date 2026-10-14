import { describe, expect, it } from "vitest";
import {
  readPluginFrontmatter,
  validatePluginBundle,
} from "../../src/routes/api/install/plugin-bundle.js";

const entry = (relativePath: string, text: string) => ({
  relativePath,
  content: Buffer.from(text),
});
const root = [
  entry("package.json", '{"name":"@covel/plugin-probe","type":"module"}'),
  entry("PLUGIN.md", "---\nid: probe\nkind: plugin\ndescription: Probe\n---\n"),
];

describe("installation uses the shared manifest readers", () => {
  it("accepts an empty YAML block in a prompt-only translation", () => {
    expect(() =>
      validatePluginBundle(
        [...root, entry("PLUGIN.zh.md", "---\n---\n翻译正文\n")],
        new Set(),
      ),
    ).not.toThrow();
  });

  it.each(["runtime.md", "RUNTIME.zh.md", "helper.js", "nested/helper.js"])(
    "diagnoses a runtime directory containing only %s",
    (filename) => {
      expect(() =>
        validatePluginBundle(
          [...root, entry(`runtimes/missing/${filename}`, "---\n---\n")],
          new Set(),
        ),
      ).toThrow("runtimes/missing/RUNTIME.md: missing runtime manifest");
    },
  );

  it("allows shared code outside runtimes/", () => {
    expect(() =>
      validatePluginBundle(
        [
          ...root,
          entry("lib/helper.js", "throw new Error('must not execute')"),
        ],
        new Set(),
      ),
    ).not.toThrow();
  });

  it.each(["js", "javascript", "yaml", "json"])(
    "rejects the %s engine directive before parsing",
    (engine) => {
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const probe = "__covelInstallFrontmatterProbe";
      try {
        expect(() =>
          readPluginFrontmatter(
            `---${engine}\n(() => { globalThis.${probe} = true; return {}; })()\n---\n`,
          ),
        ).toThrow("plain YAML frontmatter");
        expect(globals[probe]).toBeUndefined();
      } finally {
        delete globals[probe];
      }
    },
  );
});
