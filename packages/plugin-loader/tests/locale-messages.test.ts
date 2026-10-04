import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePluginLabels } from "../src/locale-labels.js";
import {
  compileUiText,
  findCodeTexts,
  missingTranslations,
} from "../src/locale-messages.js";
import { loadPluginUiSpec } from "../src/ui-spec.js";

/**
 * A UI spec holds English text. `locales/<locale>.yaml` translates it under
 * `messages`, from the English text to the translation, and the loader
 * compiles the result into the locale maps the client resolves.
 */
describe("plugin UI text translations", () => {
  let dir: string;

  const SPEC = {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    emptyState: { message: "No entries yet." },
    view: {
      component: "Text",
      props: { content: "{{count}} entries collected", variant: "muted" },
      children: [
        {
          component: "Button",
          props: { label: "Add note" },
          on: {
            click: {
              action: "invokeRuntime",
              params: { payload: { title: "Add note" } },
            },
          },
        },
        {
          component: "EntryList",
          props: { itemPropMap: { title: "value/title" } },
        },
      ],
    },
  };
  const CHINESE = `
messages:
  Codex: 知识图鉴
  shortLabel|Codex: 图鉴
  No entries yet.: 还没有条目。
  "{{count}} entries collected": 已收录 {{count}} 条
  Add note: 添加记录
`;

  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-messages-"));
    await write("PLUGIN.md", "---\nid: demo\nkind: plugin\n---\n");
    await write("ui/panel.json", JSON.stringify(SPEC));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const load = () =>
    loadPluginUiSpec(dir, path.join(dir, "ui/panel.json"), "demo");

  it("leaves a spec with no translation as written", async () => {
    expect(await load()).toEqual(SPEC);
  });

  it("compiles each translated text into a locale map", async () => {
    await write("locales/zh.yaml", CHINESE);
    await write("locales/ja.yaml", "messages:\n  Codex: 図鑑\n");
    const spec = (await load()) as typeof SPEC;

    expect(spec.label).toEqual({ en: "Codex", ja: "図鑑", zh: "知识图鉴" });
    // A key that names the property wins for that property.
    expect(spec.shortLabel).toEqual({ en: "Codex", ja: "図鑑", zh: "图鉴" });
    expect(spec.emptyState.message).toEqual({
      en: "No entries yet.",
      zh: "还没有条目。",
    });
    expect(spec.view.props.content).toEqual({
      en: "{{count}} entries collected",
      zh: "已收录 {{count}} 条",
    });
    expect(spec.view.children[0]!.props!.label).toEqual({
      en: "Add note",
      zh: "添加记录",
    });
  });

  it("translates text only: not a component, an action payload or a data path", async () => {
    await write(
      "locales/zh.yaml",
      `${CHINESE}  Text: 文本\n  muted: 弱化\n  value/title: 标题\n`,
    );
    const spec = (await load()) as typeof SPEC;

    expect(spec.view.component).toBe("Text");
    expect(spec.view.props.variant).toBe("muted");
    // The same English text as the button label, sent to a runtime as data.
    expect(spec.view.children[0]!.on).toEqual(SPEC.view.children[0]!.on);
    expect(spec.view.children[1]!.props).toEqual(SPEC.view.children[1]!.props);
  });

  it("does not change the spec it is given", () => {
    const before = structuredClone(SPEC);
    compileUiText(SPEC, [
      { locale: "zh", file: "locales/zh.yaml", messages: { Codex: "图鉴" } },
    ]);
    expect(SPEC).toEqual(before);
  });

  it("lists the texts a language does not translate", async () => {
    await write("locales/zh.yaml", "messages:\n  Codex: 知识图鉴\n");
    await write(
      "ui/toast.json",
      JSON.stringify({ props: { content: "🎲", title: "§ MARK" } }),
    );

    expect(await missingTranslations(dir, "zh")).toEqual([
      { file: "ui/panel.json", where: "message", text: "No entries yet." },
      {
        file: "ui/panel.json",
        where: "content",
        text: "{{count}} entries collected",
      },
      { file: "ui/panel.json", where: "label", text: "Add note" },
      // A text with no letters needs no translation; a mark with letters does.
      { file: "ui/toast.json", where: "title", text: "§ MARK" },
    ]);
    expect(await missingTranslations(dir, "ja")).toHaveLength(6);
  });

  describe("validatePluginLabels", () => {
    it("accepts a catalog whose every entry is a text of the UI", async () => {
      await write("locales/zh.yaml", CHINESE);
      expect(await validatePluginLabels(dir)).toEqual([]);
    });

    it("reports a translation of text the UI no longer has", async () => {
      await write("locales/zh.yaml", `${CHINESE}  Old title: 旧标题\n`);
      expect(await validatePluginLabels(dir)).toEqual([
        expect.stringContaining(
          'locales/zh.yaml: messages: "Old title" is not a text of this plugin\'s UI',
        ),
      ]);
    });

    it("reports a translation that lost a placeholder", async () => {
      await write(
        "locales/zh.yaml",
        'messages:\n  "{{count}} entries collected": 已收录若干条\n',
      );
      expect(await validatePluginLabels(dir)).toEqual([
        expect.stringContaining(
          "has placeholders {{count}} and its translation has (none)",
        ),
      ]);
    });

    it("reports a locale map written in the spec", async () => {
      await write(
        "ui/panel.json",
        JSON.stringify({ ...SPEC, label: { zh: "图鉴", en: "Codex" } }),
      );
      expect(await validatePluginLabels(dir)).toEqual([
        expect.stringContaining(
          "ui/panel.json: 1 text(s) written as a locale map (label)",
        ),
      ]);
    });
  });
});

describe("text in plugin code", () => {
  it("reads the English text of each translate and labelText call", () => {
    const source = [
      'import { labelText, translate } from "@covel/plugin-handlers-utils";',
      "// A standalone plugin defines the helper itself.",
      "export function translate(ctx, text, params) { return text; }",
      'const a = translate(ctx, "World time: {display}", { display });',
      "const b = labelText(context, 'Critical success');",
      "const c = translate(",
      "  ctx,",
      '  "Say \\"here\\" now",',
      ");",
      "const d = translate(ctx, `Welcome to ${world}`);",
      "const e = labelText(ctx, config.label);",
      "const f = translate(options.ctx, `plain template`);",
    ].join("\n");
    const { texts, dynamic } = findCodeTexts(source);

    expect(texts.map((item) => item.text)).toEqual([
      "World time: {display}",
      "Critical success",
      'Say "here" now',
      "plain template",
    ]);
    // A text built at run time cannot be a catalog key.
    expect(dynamic.map((item) => [item.line, item.call])).toEqual([
      [10, "translate"],
      [11, "labelText"],
    ]);
  });
});

describe("catalog entries for text in plugin code", () => {
  let dir: string;
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-code-messages-"));
    await write("PLUGIN.md", "---\nid: demo\nkind: plugin\n---\n");
    await write(
      "rpc/time.js",
      'export default (payload, ctx) => translate(ctx, "World time: {display}", payload);\n',
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("accepts a translation of text the code has, and lists a text without one", async () => {
    expect(await missingTranslations(dir, "zh")).toEqual([
      { file: "rpc/time.js", where: "line 1", text: "World time: {display}" },
    ]);

    await write(
      "locales/zh.yaml",
      'messages:\n  "World time: {display}": 世界时间：{display}\n',
    );
    expect(await validatePluginLabels(dir)).toEqual([]);
    expect(await missingTranslations(dir, "zh")).toEqual([]);
  });

  it("reports a translation of text the code no longer has", async () => {
    await write("locales/zh.yaml", "messages:\n  Time is {display}: 时间\n");
    expect(await validatePluginLabels(dir)).toEqual([
      expect.stringContaining(
        '"Time is {display}" is not a text of this plugin\'s UI or code',
      ),
    ]);
  });

  it("reports a text that is built at run time", async () => {
    await write(
      "rpc/roll.js",
      "export default (payload, ctx) => translate(ctx, `Rolled ${payload.n}`);\n",
    );
    expect(await validatePluginLabels(dir)).toEqual([
      expect.stringContaining(
        "rpc/roll.js:1: translate() needs the English text as a constant",
      ),
    ]);
  });

  it("does not read tests or installed packages", async () => {
    await write("tests/time.test.js", 'translate(ctx, "Only in a test");\n');
    await write(
      "node_modules/dep/index.js",
      'translate(ctx, "Only in a dependency");\n',
    );
    expect(
      (await missingTranslations(dir, "zh")).map((item) => item.text),
    ).toEqual(["World time: {display}"]);
  });
});
