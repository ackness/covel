import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkPromptVariants } from "../lib/prompt-variants.mjs";

const FRONTMATTER = `---
id: demo
runtime:
  type: agent
  agent:
    tools:
      plugin:
        - update-demo
---
`;
const ENGLISH = `${FRONTMATTER}
Read \`runtime-inputs.worldIR.value\`. Then call \`update-demo\` one time.
`;
const CHINESE = `---
---

读取 \`runtime-inputs.worldIR.value\`，然后调用一次 \`update-demo\`。
`;

/** One plugin with the given prompt files, and helpers bound to it. */
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-prompts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginsDir = path.join(root, "plugins");
  const pluginDir = path.join(pluginsDir, "demo");
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await fs.writeFile(path.join(pluginDir, name), content);
  const options = {
    pluginsDir,
    lockPath: path.join(pluginsDir, "prompt-variants.lock.json"),
  };
  return {
    check: (extra) => checkPromptVariants({ ...options, ...extra }).problems,
    lock: () => checkPromptVariants({ ...options, write: true }).problems,
    write: (name, content) => fs.writeFile(path.join(pluginDir, name), content),
  };
}

test("accepts a recorded English prompt and its Chinese variant", async (t) => {
  const plugin = await fixture(t, {
    "PLUGIN.md": ENGLISH,
    "PLUGIN.zh.md": CHINESE,
  });
  assert.deepEqual(plugin.lock(), []);
  assert.deepEqual(plugin.check(), []);
});

test("accepts a prompt that has no Chinese variant", async (t) => {
  const plugin = await fixture(t, { "PLUGIN.md": ENGLISH });
  assert.deepEqual(plugin.check(), []);
});

test("requires a Chinese variant for a bundled prompt that a model reads", async (t) => {
  const agent = await fixture(t, { "PLUGIN.md": ENGLISH });
  assert.match(
    agent.check({ requireChinese: true }).join("\n"),
    /must also ship PLUGIN\.zh\.md/,
  );

  const documented = await fixture(t, {
    "PLUGIN.md": ENGLISH.replace("type: agent", "type: function"),
  });
  assert.deepEqual(documented.check({ requireChinese: true }), []);
});

test("rejects a Chinese canonical prompt", async (t) => {
  const plugin = await fixture(t, {
    "PLUGIN.md": `${FRONTMATTER}\n你是好感度追踪器，负责读取本回合的叙事并记录变化。\n`,
  });
  const problems = plugin.check();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /canonical prompt must be English/);
});

for (const tag of ["ru", "en", "zh-Hant"])
  test(`rejects a ${tag} variant, which is never read`, async (t) => {
    const plugin = await fixture(t, {
      "PLUGIN.md": ENGLISH,
      [`PLUGIN.${tag}.md`]: "---\n---\n\nRead the input.\n",
    });
    const problems = plugin.check();
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`PLUGIN\\.${tag}\\.md: not read`));
  });

for (const [name, chinese, message] of [
  [
    "a tool",
    "---\n---\n\n读取 `runtime-inputs.worldIR.value`，然后写入结果。\n",
    /named in English but not in PLUGIN\.zh\.md: update-demo/,
  ],
  [
    "a bound input",
    "---\n---\n\n读取输入，然后调用一次 `update-demo`。\n",
    /named in English but not in PLUGIN\.zh\.md: runtime-inputs\.worldIR/,
  ],
  [
    "an injected block",
    `${CHINESE}\n已有记录在 \`<existing-demo>\` 块中。\n`,
    /named in PLUGIN\.zh\.md but not in English: <existing-demo>/,
  ],
])
  test(`rejects ${name} named in only one language`, async (t) => {
    const plugin = await fixture(t, {
      "PLUGIN.md": ENGLISH,
      "PLUGIN.zh.md": chinese,
    });
    assert.match(plugin.lock().join("\n"), message);
  });

test("rejects an English change that the Chinese variant did not follow", async (t) => {
  const plugin = await fixture(t, {
    "PLUGIN.md": ENGLISH,
    "PLUGIN.zh.md": CHINESE,
  });
  plugin.lock();
  await plugin.write(
    "PLUGIN.md",
    `${ENGLISH}\nDo not write more than three records.\n`,
  );
  const problems = plugin.check();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /English prompt changed and the Chinese variant/);
});

test("ignores reformatting and asks to record a pair that changed on both sides", async (t) => {
  const plugin = await fixture(t, {
    "PLUGIN.md": ENGLISH,
    "PLUGIN.zh.md": CHINESE,
  });
  plugin.lock();
  await plugin.write("PLUGIN.md", ENGLISH.replace("Then call", "Then\ncall"));
  assert.deepEqual(plugin.check(), []);

  await plugin.write("PLUGIN.md", `${ENGLISH}\nWrite at most three records.\n`);
  await plugin.write("PLUGIN.zh.md", `${CHINESE}\n最多写入三条记录。\n`);
  assert.match(plugin.check().join("\n"), /the pair changed/);
  assert.deepEqual(plugin.lock(), []);
  assert.deepEqual(plugin.check(), []);
});

test("reports a Chinese variant that was never recorded", async (t) => {
  const plugin = await fixture(t, {
    "PLUGIN.md": ENGLISH,
    "PLUGIN.zh.md": CHINESE,
  });
  assert.match(plugin.check().join("\n"), /new Chinese variant/);
});

test("checks a directory that has no lock, such as the templates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-prompts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginsDir = path.join(root, "templates");
  await fs.mkdir(path.join(pluginsDir, "demo"), { recursive: true });
  const file = path.join(pluginsDir, "demo", "PLUGIN.md");

  await fs.writeFile(file, ENGLISH);
  assert.deepEqual(checkPromptVariants({ pluginsDir }).problems, []);

  await fs.writeFile(
    file,
    `${FRONTMATTER}\n你是示例插件的 runtime。读取本轮叙事，然后调用一次工具写入记录。\n`,
  );
  const problems = checkPromptVariants({ pluginsDir }).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /canonical prompt must be English/);
  assert.deepEqual(await fs.readdir(pluginsDir), ["demo"]);
});
