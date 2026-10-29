import { describe, expect, it } from "vitest";
import { readPlainYamlFrontmatter } from "../src/plain-yaml-frontmatter.js";
import {
  rewriteContributes,
  type ExtractedDeclarations,
} from "../src/rewrite-contributes.js";

const empty: ExtractedDeclarations = {
  tools: [],
  actions: [],
  services: [],
  forms: [],
  wires: [],
  hooks: [],
  extensions: [],
  commands: [],
  localizedContributes: [],
};

describe("rewriteContributes", () => {
  it("preserves comments, other fields, key order, list style, quotes and the body", () => {
    const original = `---
# Package comment
description: 'Keep this quoting'
contributes:
  # Tools comment
  tools: ["old", "keep"] # List comment
  datasets: { notes: { schema: ./note.json, key: id } } # Dataset comment
  actions:
    - before # Action comment
  extensions: [{ point: ui.slot@1, id: summary, order: 10 }]
  commands: [{ name: open, action: after }]
runtime: { agent: { history: { maxTurns: 2 } } }
---
\n# Body  \n\nKeep --- and CRLF\r\nbyte-identical.\n`;
    const extracted = { ...empty, tools: ["keep", "new"], actions: ["after"] };
    const result = rewriteContributes(original, extracted);
    expect(result.changed).toEqual(["tools", "actions"]);
    expect(result.text).toBe(
      original
        .replace('["old", "keep"]', '[ "keep", "new" ]')
        .replace("- before # Action comment", "- after # Action comment"),
    );
    expect(rewriteContributes(result.text, extracted)).toEqual({
      text: result.text,
      changed: [],
      drift: [],
    });
  });

  it("removes empty keys, retaining their comments and unrelated contributions", () => {
    const result = rewriteContributes(
      `---
contributes:
  # Keep this comment
  tools: [old] # Keep this too
  actions: []
  data: { notes: { schema: ./note.json } }
---
Body\n`,
      empty,
    );
    expect(result.changed).toEqual(["tools", "actions"]);
    expect(result.text).not.toMatch(/  (tools|actions):/);
    expect(result.text).toContain(
      "  data: { notes: { schema: ./note.json } }\n",
    );
    expect(result.text).toContain("# Keep this comment");
    expect(result.text).toContain("# Keep this too");
    expect(rewriteContributes(result.text, empty).changed).toEqual([]);
  });

  it("writes canonical hook shapes and preserves registration order", () => {
    const extracted: ExtractedDeclarations = {
      ...empty,
      hooks: ["TurnStart", { event: "PreToolUse", enforce: "pre" }],
    };
    const result = rewriteContributes(
      `---
contributes:
  hooks:
    - { event: TurnStart, enforce: normal }
    - PreToolUse
---
`,
      extracted,
    );
    expect(readPlainYamlFrontmatter(result.text).data.contributes).toEqual({
      hooks: extracted.hooks,
    });
    expect(rewriteContributes(result.text, extracted).changed).toEqual([]);
  });

  it("creates contributes only for nonempty lists, in the defined key order", () => {
    const original = "---\ndescription: Keep\n---\nBody\n";
    expect(rewriteContributes(original, empty).text).toBe(original);
    const extracted = { ...empty, tools: ["z", "a"], forms: ["form"] };
    const result = rewriteContributes(original, extracted);
    expect(result.text).toBe(
      "---\ndescription: Keep\ncontributes:\n  tools:\n    - z\n    - a\n  forms:\n    - form\n---\nBody\n",
    );
    expect(rewriteContributes(result.text, extracted).changed).toEqual([]);
  });

  it.each([2, 4])(
    "adds a missing kind inside an existing block mapping with %i-space indentation",
    (width) => {
      const indent = " ".repeat(width);
      const original = `---\ncontributes:\n${indent}tools: [save]\n${indent}# Trailing comment\ndescription: Keep\n---\nBody\n`;
      const extracted = { ...empty, tools: ["save"], actions: ["open"] };
      const result = rewriteContributes(original, extracted);
      expect(readPlainYamlFrontmatter(result.text).data).toEqual({
        contributes: { tools: ["save"], actions: ["open"] },
        description: "Keep",
      });
      expect(result.text).toContain(`\n${indent}actions:\n`);
      expect(result.text).toContain(
        `${indent}# Trailing comment\ndescription: Keep\n---\nBody\n`,
      );
      expect(rewriteContributes(result.text, extracted)).toEqual({
        text: result.text,
        changed: [],
        drift: [],
      });
    },
  );

  it.each([",}", ", # Trailing comment\n}"])(
    "adds a missing kind before flow-mapping trailing trivia: %s",
    (ending) => {
      const original = `---\ncontributes: {tools: [save]${ending}\ndescription: Keep\n---\nBody\n`;
      const extracted = { ...empty, tools: ["save"], actions: ["open"] };
      const result = rewriteContributes(original, extracted);
      expect(readPlainYamlFrontmatter(result.text).data).toEqual({
        contributes: { tools: ["save"], actions: ["open"] },
        description: "Keep",
      });
      expect(result.text).toContain(
        `${ending}\ndescription: Keep\n---\nBody\n`,
      );
      expect(rewriteContributes(result.text, extracted)).toEqual({
        text: result.text,
        changed: [],
        drift: [],
      });
    },
  );

  it("creates contributes before a root flow mapping's trailing comma", () => {
    const original = "---\n{description: Keep,}\n---\nBody\n";
    const extracted = { ...empty, actions: ["open"] };
    const result = rewriteContributes(original, extracted);
    expect(readPlainYamlFrontmatter(result.text).data).toEqual({
      description: "Keep",
      contributes: { actions: ["open"] },
    });
    expect(rewriteContributes(result.text, extracted)).toEqual({
      text: result.text,
      changed: [],
      drift: [],
    });
  });

  it("preserves flow maps and every untouched value byte", () => {
    const original =
      '---\ncontributes: {tools: [old], data: {notes: {schema: "./note.json"}}, forms: [old]}\n---\nBody\n';
    const extracted = { ...empty, actions: ["act"] };
    const result = rewriteContributes(original, extracted);
    expect(result.text).toContain('data: {notes: {schema: "./note.json"}}');
    expect(readPlainYamlFrontmatter(result.text).data.contributes).toEqual({
      data: { notes: { schema: "./note.json" } },
      actions: ["act"],
    });
    expect(rewriteContributes(result.text, extracted).changed).toEqual([]);
  });

  it("keeps CRLF, BOM and body bytes", () => {
    const original =
      '\uFEFF---\r\ncontributes:\r\n  tools: [old]\r\nother: "same"\r\n---\r\nBody  \r\n';
    const extracted = { ...empty, tools: ["new"] };
    const result = rewriteContributes(original, extracted);
    expect(result.text).toBe(original.replace("[old]", "[ new ]"));
    expect(rewriteContributes(result.text, extracted).changed).toEqual([]);
  });

  it("keeps an existing contributes mapping valid after removing its last list", () => {
    const result = rewriteContributes(
      "---\ncontributes: # Registration comment\n  tools: [old] # preserved\n---\n",
      empty,
    );
    expect(readPlainYamlFrontmatter(result.text).data.contributes).toEqual({});
    expect(result.text).toContain("# preserved");
    expect(result.text).toContain("# Registration comment");
    expect(rewriteContributes(result.text, empty).changed).toEqual([]);
  });

  it("supports empty frontmatter and preserves comments when creating the first field", () => {
    const original = "---\n# Package comment\n---\nBody\n";
    expect(rewriteContributes(original, empty).text).toBe(original);
    const extracted = { ...empty, tools: ["new"] };
    const result = rewriteContributes(original, extracted);
    expect(result.text).toBe(
      original.replace(
        "# Package comment\n",
        "# Package comment\ncontributes:\n  tools:\n    - new\n",
      ),
    );
    expect(rewriteContributes(result.text, extracted).changed).toEqual([]);
  });

  it("preserves mixed line endings in untouched fields", () => {
    const original =
      '---\r\ncontributes:\r\n  tools: [old]\r\nother: "keep"\nlast: value\r\n---\r\nBody\n';
    expect(
      rewriteContributes(original, { ...empty, tools: ["new"] }).text,
    ).toBe(original.replace("[old]", "[ new ]"));
  });

  it("reports order drift even when all names are already declared", () => {
    const result = rewriteContributes(
      "---\ncontributes:\n  tools: [a, b]\n---\n",
      { ...empty, tools: ["b", "a"] },
    );
    expect(result.drift).toEqual([{ key: "tools", added: [], removed: [] }]);
    expect(readPlainYamlFrontmatter(result.text).data.contributes).toEqual({
      tools: ["b", "a"],
    });
  });

  it("leaves extension and command metadata untouched", () => {
    const original =
      "---\ncontributes:\n  extensions: [ui.slot@1/summary]\n  commands: [{name: open, action: open}]\n---\n";
    expect(
      rewriteContributes(original, {
        ...empty,
        extensions: ["prompt.segment@1/new"],
      }).text,
    ).toBe(original);
  });

  it.each([
    "---js\nreturn {}\n---\n",
    "---\ncontributes: [tools]\n---\n",
    "---\ncontributes: { tools: [x], tools: [y] }\n---\n",
  ])("rejects unsafe or ambiguous YAML: %s", (source) => {
    expect(() => rewriteContributes(source, empty)).toThrow();
  });
});
