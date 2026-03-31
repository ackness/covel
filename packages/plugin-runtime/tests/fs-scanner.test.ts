import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanPluginDirectory } from "../src/loader/fs-scanner.js";

describe("fs-scanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "plugin-scan-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discovers valid plugins", async () => {
    const pluginDir = join(tempDir, "my-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        id: "my-plugin",
        displayName: "My Plugin",
        version: "0.1.0",
        author: "test",
        description: "desc",
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      })
    );

    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].manifest.id).toBe("my-plugin");
    expect(results[0].dir).toBe(pluginDir);
  });

  it("skips directories without plugin.json", async () => {
    await mkdir(join(tempDir, "no-manifest"), { recursive: true });
    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(0);
  });

  it("skips directories with invalid JSON", async () => {
    const pluginDir = join(tempDir, "bad-json");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), "not valid json");

    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(0);
  });

  it("skips directories with invalid manifest schema", async () => {
    const pluginDir = join(tempDir, "bad-schema");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ schemaVersion: "1.0" })
    );

    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(0);
  });

  it("skips hidden directories", async () => {
    const pluginDir = join(tempDir, ".hidden-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        id: "hidden",
        displayName: "Hidden",
        version: "0.1.0",
        author: "test",
        description: "desc",
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      })
    );

    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(0);
  });

  it("discovers multiple plugins", async () => {
    for (const name of ["plugin-a", "plugin-b"]) {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify({
          schemaVersion: "1.0",
          id: name,
          displayName: name,
          version: "0.1.0",
          author: "test",
          description: "desc",
          defaultLocale: "zh-CN",
          supportedLocales: ["zh-CN"],
        })
      );
    }

    const results = await scanPluginDirectory(tempDir);
    expect(results).toHaveLength(2);
  });
});
