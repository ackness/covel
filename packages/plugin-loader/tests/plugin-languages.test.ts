import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describePluginLanguages,
  pluginLanguages,
} from "../src/plugin-languages.js";

describe("pluginLanguages", () => {
  let dir: string;
  const write = async (file: string, content = "") => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-languages-"));
    await write("PLUGIN.md", "---\nid: demo\nkind: plugin\n---\n");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is English only for a package with no locale file and no variant", async () => {
    expect(await pluginLanguages(dir)).toEqual({
      text: ["en"],
      instructions: ["en"],
    });
  });

  it("adds a language of text for each locale file", async () => {
    await write("locales/zh.yaml", "PLUGIN.md:\n  displayName: 演示\n");
    await write("locales/ja.yaml", "PLUGIN.md:\n  displayName: デモ\n");
    // Not a language: the lock file and notes are not translations.
    await write("locales/lock.json", "{}");
    await write("locales/notes.yaml", "a: b\n");

    expect((await pluginLanguages(dir)).text).toEqual(["en", "ja", "zh"]);
  });

  it("adds Chinese instructions when one manifest has a Chinese variant", async () => {
    await write("runtimes/story/RUNTIME.md", "---\nid: story\n---\nWrite.\n");
    await write("runtimes/story/RUNTIME.zh.md", "写。\n");

    const languages = await pluginLanguages(dir);
    expect(languages.instructions).toEqual(["en", "zh"]);
    expect(describePluginLanguages(languages)).toBe(
      "text en; instructions en, zh",
    );
  });
});
