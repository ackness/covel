import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPromptLoader,
  loadPrompt,
  setPromptsRoot,
} from "../src/index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-prompt-loaders-"));
});
afterEach(async () => {
  setPromptsRoot(null);
  await rm(root, { recursive: true, force: true });
});

async function fixture(owner: string, files: Record<string, string>) {
  const promptRoot = path.join(root, owner);
  await mkdir(path.join(promptRoot, "server"), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(promptRoot, "server", name), content, "utf8"),
    ),
  );
  return promptRoot;
}

it("isolates concurrent loaders from each other and changes to the default", async () => {
  const firstRoot = await fixture("first", { "compactor.md": "first" });
  const secondRoot = await fixture("second", { "compactor.md": "second" });
  const first = createPromptLoader(firstRoot);
  const second = createPromptLoader(secondRoot);
  setPromptsRoot(firstRoot);
  const pendingDefault = loadPrompt("server", "compactor");
  setPromptsRoot(secondRoot);

  expect(
    await Promise.all([
      first("server", "compactor"),
      second("server", "compactor"),
      pendingDefault,
      loadPrompt("server", "compactor"),
      first("server", "compactor"),
    ]),
  ).toEqual(["first", "second", "first", "second", "first"]);
});

it("keeps exact, language, English and canonical fallback within its own root", async () => {
  const promptRoot = await fixture("locales", {
    "compactor.ru-RU.md": "exact",
    "compactor.ru.md": "language",
    "compactor.en.md": "English",
    "compactor.zh.md": "Simplified Chinese",
    "compactor.md": "canonical",
  });
  const loader = createPromptLoader(promptRoot);
  expect(await loader("server", "compactor", "ru_ru")).toBe("exact");
  expect(await loader("server", "compactor", "ru-KZ")).toBe("language");
  expect(await loader("server", "compactor", "ja-JP")).toBe("English");
  expect(await loader("server", "compactor", "zh-Hant-TW")).toBe("English");
  expect(await loader("server", "compactor")).toBe("canonical");
  await rm(path.join(promptRoot, "server", "compactor.en.md"));
  expect(await loader("server", "compactor", "ja-JP")).toBe("canonical");
});

it("observes template edits without recreating the loader", async () => {
  const promptRoot = await fixture("editable", { "compactor.md": "before" });
  const loader = createPromptLoader(path.relative(process.cwd(), promptRoot));
  expect(await loader("server", "compactor")).toBe("before");
  await writeFile(
    path.join(promptRoot, "server", "compactor.md"),
    "after",
    "utf8",
  );
  expect(await loader("server", "compactor")).toBe("after");
});

it("does not fall through to the default root or hide invalid locale and IO errors", async () => {
  const defaultRoot = await fixture("default", { "compactor.md": "default" });
  const isolatedRoot = await fixture("isolated", {});
  setPromptsRoot(defaultRoot);
  const loader = createPromptLoader(isolatedRoot);
  await expect(loader("server", "compactor")).rejects.toThrow(
    "No prompt file found",
  );
  await expect(loader("server", "compactor", "../../secret")).rejects.toThrow(
    "Invalid locale",
  );
  await mkdir(path.join(isolatedRoot, "server", "compactor.md"));
  await expect(loader("server", "compactor")).rejects.toMatchObject({
    code: "EISDIR",
  });
});
