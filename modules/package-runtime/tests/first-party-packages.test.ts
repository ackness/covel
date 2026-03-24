import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PackageRuntime } from "../src/index.js";

describe("first-party package discovery", () => {
  it("discovers the documented first-party packages from the extensions directory", async () => {
    const runtime = new PackageRuntime({
      packagesRoot: resolve(process.cwd(), "extensions")
    });

    const discovered = await runtime.discover();

    expect(discovered.map((pkg) => pkg.name)).toEqual([
      "core-archive",
      "core-character-card",
      "core-debug-commands",
      "core-guide",
      "core-memory-rag",
      "core-persona",
      "core-presets",
      "core-worldbook"
    ]);
  });

  it("can enable the real core-guide package and expose its contributions", async () => {
    const runtime = new PackageRuntime({
      packagesRoot: resolve(process.cwd(), "extensions")
    });

    await runtime.discover();
    const pkg = await runtime.enable("core-guide");

    expect(pkg.enabled).toBe(true);
    expect(pkg.skillMarkdown).toContain("choices");
    expect(runtime.getCommand("guide")).toMatchObject({
      packageName: "core-guide"
    });
    expect(runtime.getCommand("guide")?.execute).toBeTypeOf("function");
    expect(runtime.getBlock("choices")).toMatchObject({
      packageName: "core-guide"
    });
    expect(runtime.getRenderer("choices")).toMatchObject({
      packageName: "core-guide"
    });
  });
});
