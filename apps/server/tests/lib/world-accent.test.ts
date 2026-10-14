// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { stringify } from "yaml";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

async function makeWorld(extra: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "covel-world-accent-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "world.yaml"),
    stringify({
      schemaVersion: "1.0",
      id: "accent-world",
      name: "Accent World",
      summary: "A world with an optional accent colour.",
      defaultLocale: "en-US",
      ...extra,
    }),
  );
  await writeFile(path.join(root, "WORLD.md"), "The game can continue.");
  return root;
}

it.each(["#202020", "#ffffff", "oklch(91% 0.12 75)", "red", 123, null])(
  "loads a world without invalid accentColor %s, warns, and reports an authoring error",
  async (accentColor) => {
    const root = await makeWorld({ accentColor });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warning.mockRestore());

    const record = await loadSingleWorld(root);
    expect(record?.id).toBe("accent-world");
    expect(record?.lore).toBe("The game can continue.");
    expect(record?.metadata).not.toHaveProperty("accentColor");
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /accent-world.*accentColor.*ignored.*(colour|lightness)/,
      ),
    );

    const { diagnostics } = await validateWorldPackage({
      worldDir: root,
      pluginsDirs: [],
    });
    const errors = diagnostics.filter((item) => item.level === "error");
    expect(errors).toEqual([
      expect.objectContaining({
        code: "manifest-invalid",
        file: "world.yaml",
        pointer: "accentColor",
      }),
    ]);
    const message = errors.map((item) => item.message).join(" ");
    for (const part of ["hex", "oklch", "55%", "90%"])
      expect(message).toContain(part);
  },
);

it.each([undefined, "#c9a24b", "oklch(55% 0.12 75)", "oklch(90% 0.12 75)"])(
  "preserves a supported or absent accentColor %s without warning",
  async (accentColor) => {
    const root = await makeWorld(
      accentColor === undefined ? {} : { accentColor },
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warning.mockRestore());
    const record = await loadSingleWorld(root);
    expect(record?.id).toBe("accent-world");
    expect(record?.metadata?.accentColor).toBe(accentColor);
    expect(warning).not.toHaveBeenCalled();
  },
);

it("still rejects invalid required manifest fields alongside an invalid accent", async () => {
  const root = await makeWorld({ id: "../invalid", accentColor: "red" });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warning.mockRestore());
  expect(await loadSingleWorld(root)).toBeNull();
});
