import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  planPluginAssetRoot as plan,
  scanPluginAssetRoot as scan,
  MAX_PLUGIN_ASSET_BYTES,
  MAX_PLUGIN_ASSET_FILES,
  MAX_PLUGIN_ASSET_FILE_BYTES,
} from "../src/ui-assets.js";
const specialFiles = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (file: import("node:fs").PathLike) => {
      const stat = actual.lstatSync(file);
      // Model a device/FIFO without requiring native mknod or a listening socket.
      return specialFiles.has(String(file))
        ? Object.assign(stat, {
            isFile: () => false,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          })
        : stat;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  specialFiles.clear();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const file = (relativePath: string, size = 1) => ({ relativePath, size });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "covel-assets-"));
  roots.push(root);
  await writeFile(path.join(root, "index.html"), "<head></head>");
  return root;
}
describe("UI asset planner", () => {
  it("publishes only the entry and the explicit extension allowlist", () => {
    const names = [
      "index.html",
      "a.JS",
      "a.css",
      "a.json",
      "a.txt",
      "a.png",
      "a.jpg",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.avif",
      "a.svg",
      "a.woff2",
      "a.woff",
    ];
    const rejected = [
      "other.html",
      "a.mjs",
      "a.wasm",
      "a.map",
      "README",
      ".a.js",
      "a/.b/c.js",
      "node_modules/x.js",
      "a/node_modules/x.js",
    ];
    const result = plan(
      [...names, ...rejected].map((name) => file(name)),
      "index.html",
    );
    expect([...result.listed.keys()]).toEqual(names);
    expect(result.issues).toEqual([]);
    expect(result.listed.get("a.JS")?.mime).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(result.listed.get("a.svg")?.mime).toBe("image/svg+xml");
  });
  it.each(["__covel__", "__covel__/a.js", "sub/__covel__/a.js"])(
    "reports reserved name %s",
    (name) => {
      expect(
        plan([file("index.html"), file(name)], "index.html").issues,
      ).toContainEqual({
        path: "webview.root",
        message: "the name __covel__ is reserved",
      });
    },
  );
  it.each(["PLUGIN.md", "RUNTIME.md", ".covel-install.json"])(
    "rejects package markers %s",
    (name) => {
      expect(
        plan([file("index.html"), file(name)], "index.html").issues,
      ).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("not the package root"),
        }),
      );
    },
  );
  it("reports an absent or unlisted entry and zero files", () => {
    expect(plan([], "index.html").issues.map((issue) => issue.path)).toEqual([
      "webview.entry",
      "webview.root",
    ]);
    expect(plan([file("other.html")], "index.html").listed.size).toBe(0);
  });
  it("accepts limits exactly and rejects only values over them", () => {
    const files = Array.from({ length: MAX_PLUGIN_ASSET_FILES - 1 }, (_, i) =>
      file(`${i}.js`),
    );
    expect(plan([file("index.html"), ...files], "index.html").issues).toEqual(
      [],
    );
    expect(
      plan([file("index.html"), ...files, file("extra.js")], "index.html")
        .issues,
    ).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("512") }),
    );
    expect(
      plan([file("index.html", MAX_PLUGIN_ASSET_FILE_BYTES)], "index.html")
        .issues,
    ).toEqual([]);
    expect(
      plan([file("index.html", MAX_PLUGIN_ASSET_FILE_BYTES + 1)], "index.html")
        .issues,
    ).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("8 MiB") }),
    );
    const total = [
      file("index.html", MAX_PLUGIN_ASSET_BYTES / 4),
      ...[1, 2, 3].map((i) => file(`${i}.js`, MAX_PLUGIN_ASSET_BYTES / 4)),
    ];
    expect(plan(total, "index.html").issues).toEqual([]);
    expect(
      plan([...total, file("extra.js")], "index.html").issues,
    ).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("32 MiB") }),
    );
  });
});
describe("UI asset disk scanner", () => {
  it("hashes content, names and the published set in sorted order", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "b.js"), "ab");
    await writeFile(path.join(root, "a.js"), "cd");
    const first = await scan(root, "index.html");
    expect(first.digest).toMatch(/^[a-f0-9]{32}$/);
    expect((await scan(root, "index.html")).digest).toBe(first.digest);
    await rm(path.join(root, "b.js"));
    await writeFile(path.join(root, "b.js"), "ab");
    expect((await scan(root, "index.html")).digest).toBe(first.digest);
    await writeFile(path.join(root, "b.js"), "ac");
    expect((await scan(root, "index.html")).digest).not.toBe(first.digest);
    await writeFile(path.join(root, "b.js"), "ab");
    await rename(path.join(root, "b.js"), path.join(root, "c.js"));
    expect((await scan(root, "index.html")).digest).not.toBe(first.digest);
    await rename(path.join(root, "c.js"), path.join(root, "b.js"));
    await writeFile(path.join(root, "extra.css"), "");
    expect((await scan(root, "index.html")).digest).not.toBe(first.digest);
  });
  it.skipIf(process.platform === "win32")(
    "never follows file or directory links",
    async () => {
      const root = await fixture();
      const outside = await fixture();
      await writeFile(path.join(outside, "secret.js"), "secret");
      await symlink(
        path.join(outside, "secret.js"),
        path.join(root, "link.js"),
      );
      await symlink(outside, path.join(root, "linked"), "dir");
      await mkdir(path.join(root, ".hidden"));
      await writeFile(path.join(root, ".hidden/a.js"), "");
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, "node_modules/a.js"), "");
      expect([...(await scan(root, "index.html")).listed.keys()]).toEqual([
        "index.html",
      ]);
    },
  );
  it("reports an empty reserved directory and a package root", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "__covel__"));
    expect((await scan(root, "index.html")).issues).toContainEqual(
      expect.objectContaining({ message: "the name __covel__ is reserved" }),
    );
    await rm(path.join(root, "__covel__"), { recursive: true });
    await writeFile(path.join(root, "PLUGIN.md"), "");
    expect((await scan(root, "index.html")).issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("not the package root"),
      }),
    );
  });
});

it("rejects root-level manifest directories as well as files", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "RUNTIME.md"));
  expect((await scan(root, "index.html")).issues).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("not the package root"),
    }),
  );
});

it("does not publish special files even when their extension is allowlisted", async () => {
  const root = await fixture();
  const file = path.join(root, "device.js");
  await writeFile(file, "device");
  specialFiles.add(file);
  expect([...(await scan(root, "index.html")).listed.keys()]).toEqual([
    "index.html",
  ]);
});
