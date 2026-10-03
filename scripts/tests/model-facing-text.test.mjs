import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkFrameworkChinese,
  chineseLineCount,
  findChineseToolText,
} from "../lib/model-facing-text.mjs";

test("finds Chinese tool and parameter descriptions, on one line or several", () => {
  const source = `
export default tool({
  name: "record-note",
  description:
    "记录一条结构化笔记。",
  parameters: z.object({
    title: z.string().describe("短标题"),
    text: z
      .string()
      .describe(
        "一到两句具体记录",
      ),
    tags: z.array(z.string()).describe("Category tags"),
  }),
});`;
  assert.deepEqual(
    findChineseToolText(source).map((hit) => [hit.line, hit.text]),
    [
      [4, "记录一条结构化笔记。"],
      [7, "短标题"],
      [10, "一到两句具体记录"],
    ],
  );
});

test("leaves locale pairs and English descriptions alone", () => {
  assert.deepEqual(
    findChineseToolText(`
const label = { zh: "观察", en: "Observe" };
const tool = { description: "Record one note.", message: pick(locale, "已记录", "Recorded") };`),
    [],
  );
});

test("counts Chinese lines outside comments only", () => {
  assert.equal(
    chineseLineCount(`
// 注释里的中文不算
/* 块注释
   也不算 */
const a = "中文"; // 行尾注释不算，但这一行有字面量
const url = "https://example.com/路径";
const b = "English";`),
    2,
  );
});

async function framework(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-framework-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

test("fails on Chinese in a framework file that is not recorded", async (t) => {
  const root = await framework({
    "packages/tools/src/tools.ts": 'export const d = "搜索对话记忆";\n',
    "packages/tools/src/labels.ts":
      'export const l = { zh: "确认", en: "Confirm" };\n',
    "packages/tools/src/plain.ts": 'export const p = "Search memory";\n',
    "packages/tools/tests/x.test.ts": 'const fixture = "测试";\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const check = (allowed) =>
    checkFrameworkChinese({
      repoRoot: root,
      roots: ["packages/tools/src"],
      allowed,
    });

  const recorded = { "packages/tools/src/labels.ts": 1 };
  const problems = check(recorded);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /^packages\/tools\/src\/tools\.ts: 1 line\(s\) of Chinese text in framework source/,
  );

  // A recorded file whose count changed, and a recorded file that is gone.
  assert.match(
    check({ ...recorded, "packages/tools/src/tools.ts": 3 }).join("\n"),
    /tools\.ts: 1 line\(s\) of Chinese text, 3 recorded/,
  );
  assert.match(
    check({
      ...recorded,
      "packages/tools/src/tools.ts": 1,
      "packages/tools/src/gone.ts": 2,
    }).join("\n"),
    /gone\.ts: recorded in FRAMEWORK_CHINESE_LINES but not found/,
  );
  assert.deepEqual(
    check({ ...recorded, "packages/tools/src/tools.ts": 1 }),
    [],
  );
});
