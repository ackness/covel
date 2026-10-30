import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { expect, it } from "vitest";
import { playerVisibleLore, type LLMAdapter } from "@covel/shared";
import {
  worldTranslationStatus,
  writeWorldTranslations,
} from "../../src/world-data/locale-tooling.js";
import { translateWorldPackage } from "../../src/world-data/translate-world.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
it("the generation template's prose leaves enter translation; machine leaves and unmarked prose do not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-generation-leaves-"));
  try {
    const prompt = await readFile(
      path.join(repo, "prompts/server/generate-world.md"),
      "utf8",
    );
    // Exercise the actual schema examples, not an independently corrected fixture.
    const example = parse(prompt.match(/```yaml\n([\s\S]*?)```/)![1]!);
    const dimensions = example.dimensions as Record<
      string,
      {
        name: string;
        schema: Record<string, unknown>;
        initialValue: unknown;
      }
    >;
    const prose = Object.values(dimensions).filter(
      (d) => d.schema.type === "string",
    );
    const numeric = Object.values(dimensions).filter(
      (d) => d.schema.type === "integer",
    );
    const record = Object.values(dimensions).find(
      (d) => d.schema.type === "object",
    )!;
    expect(prose).toHaveLength(2);
    const authored = {
      reference: {
        ...prose[0],
        name: "世界参考",
        initialValue: "北岸由林夏看守。",
      },
      opening: {
        ...prose[1],
        name: "开局选择",
        initialValue: "陈舟带着铜钥匙来找林夏。",
      },
      count: { ...numeric[0], name: "铜币" },
      journal: {
        ...record,
        name: "地点记录",
        initialValue: {
          harbor: { description: "港口在北岸。", visited: true },
        },
      },
      identity: {
        name: "标识",
        schema: { type: "string" },
        initialValue: "lin-xia",
      },
      phase: {
        name: "阶段",
        schema: { type: "string", enum: ["waiting", "ready"] },
        initialValue: "ready",
      },
      unmarked: {
        name: "未标记正文",
        schema: { type: "string" },
        initialValue: "这段正文没有翻译标记。",
      },
    };
    await writeFile(
      path.join(root, "world.yaml"),
      stringify({
        id: "harbor",
        name: "港口",
        summary: "北岸的港口。",
        defaultLocale: "zh-CN",
      }),
    );
    await mkdir(path.join(root, "data"));
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      stringify(authored),
    );
    const state = await worldTranslationStatus(root, "en-US");
    const file = state.files.find((f) => f.file === "data/dimensions.yaml")!;
    const pointers = file.missing.map((u) => u.pointer);
    expect(pointers).toEqual(
      expect.arrayContaining([
        "reference.initialValue",
        "opening.initialValue",
        "journal.initialValue.harbor.description",
      ]),
    );
    for (const field of ["count", "identity", "phase", "unmarked"])
      expect(pointers).not.toContain(`${field}.initialValue`);
    expect(pointers).not.toContain("journal.initialValue.harbor.visited");
    expect(file.notTranslatable).toContain("unmarked.initialValue");
    const textValues = file.missing.filter((u) =>
      u.pointer.includes(".initialValue"),
    );
    await writeWorldTranslations(
      root,
      "en-US",
      new Map(textValues.map((u) => [u.id, `English: ${u.pointer}`])),
    );
    const overlay = parse(
      await readFile(path.join(root, "data/dimensions.en-US.yaml"), "utf8"),
    );
    expect(overlay.reference.initialValue).toContain("English:");
    expect(overlay.journal.initialValue.harbor).toEqual({
      description: expect.stringContaining("English:"),
    });
    expect(overlay).not.toHaveProperty("identity");
    expect(overlay).not.toHaveProperty("phase");
    expect(overlay).not.toHaveProperty("count");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("world translation excludes hidden lore from the shared glossary and writes source-owned boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "covel-hidden-translation-"));
  const requests: string[] = [];
  const secret = "Chen is the anonymous witness.";
  const llm: LLMAdapter = {
    async generate({ messages }) {
      const prompt = String(messages[0]?.content);
      requests.push(prompt);
      const input = prompt.split("Texts:\n")[1];
      const texts: Record<string, string | { text: string }> = input
        ? JSON.parse(input)
        : {};
      const content = input
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(texts).map(([id, value]) => {
                const text = typeof value === "string" ? value : value.text;
                return [
                  id,
                  text === secret ? "陈舟是匿名证人。" : "港口的灯亮了。",
                ];
              }),
            ),
          )
        : JSON.stringify({ Harbor: "港口" });
      return {
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  try {
    await writeFile(
      path.join(root, "world.yaml"),
      "id: harbor\nname: Harbor\nsummary: A quiet harbor.\ndefaultLocale: en-US\n",
    );
    await writeFile(
      path.join(root, "WORLD.md"),
      `# Harbor\n\nA light shines.\n<!-- narrator-only -->\n${secret}\n<!-- /narrator-only -->\nThe courier arrives.`,
    );
    const result = await translateWorldPackage({
      worldDir: root,
      locale: "zh-CN",
      llm,
    });
    expect(result.failed).toEqual([]);
    expect(result.written).toContain("WORLD.zh-CN.md");
    expect(requests[0]).not.toContain(secret);
    const lore = await readFile(path.join(root, "WORLD.zh-CN.md"), "utf8");
    expect(lore).toContain("陈舟是匿名证人。");
    expect(playerVisibleLore(lore)).not.toContain("匿名证人");
    const hidden = requests.filter((request) => request.includes(secret));
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).not.toContain("A light shines");
    expect(hidden[0]).not.toContain("The courier arrives");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
