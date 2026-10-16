import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideRoot, isPathInside } from "../src/path-containment.js";

describe("plugin path containment", () => {
  it("keeps root inclusion explicit and rejects sibling paths", () => {
    const root = path.resolve("plugin");
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInside(root, root, { allowRoot: true })).toBe(true);
    expect(isPathInside(root, path.join(root, "lib/handler.js"))).toBe(true);
    expect(isPathInside(root, `${root}-other/handler.js`)).toBe(false);
    expect(isPathInside(root, path.resolve(root, "../outside.js"))).toBe(false);
  });

  it("resolves symlinks, checks missing paths lexically, and preserves the caller's error", async () => {
    const temp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "covel-contained-")),
    );
    try {
      const root = path.join(temp, "plugin");
      await fs.mkdir(root);
      await fs.writeFile(path.join(temp, "outside.js"), "");
      await fs.symlink(
        path.join(temp, "outside.js"),
        path.join(root, "escape.js"),
      );
      await expect(
        assertInsideRoot(root, root, "escaped"),
      ).resolves.toBeUndefined();
      await expect(
        assertInsideRoot(root, path.join(root, "missing.js"), "escaped"),
      ).resolves.toBeUndefined();
      for (const target of [
        path.join(root, "escape.js"),
        path.join(temp, "missing.js"),
      ]) {
        await expect(
          assertInsideRoot(root, target, "specific error"),
        ).rejects.toThrow("specific error");
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
