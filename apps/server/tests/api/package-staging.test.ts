import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupPackageStaging } from "../../src/routes/api/install/package-staging.js";
import { deleteWorldPackage } from "../../src/routes/api/worlds/file-package.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: vi.fn(fs.rm) };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-staging-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementation(fs.rm);
  await rm(root, { recursive: true, force: true });
});

it("removes abandoned installs and uninstalls, retaining live packages and named update recovery", async () => {
  const removed = [
    ".covel-install-abandoned",
    ".covel-uninstall-partial",
    ".covel-updates/.covel-install-abandoned",
  ];
  const retained = [
    "live",
    ".unrelated",
    ".covel-world-delete-pending",
    ".covel-updates/live/package",
    ".covel-updates/live/previous",
  ];
  for (const relative of [...removed, ...retained]) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, relative, "keep.txt"), "content");
  }
  await cleanupPackageStaging(root);
  await cleanupPackageStaging(root); // Recovery is repeatable.
  for (const relative of removed)
    await expect(access(path.join(root, relative))).rejects.toMatchObject({
      code: "ENOENT",
    });
  for (const relative of retained)
    await access(path.join(root, relative, "keep.txt"));
});

it("does not traverse staging or updates symlinks, or remove unrelated files", async () => {
  const outside = path.join(root, "outside");
  const packages = path.join(root, "packages");
  await mkdir(path.join(outside, ".covel-install-retained"), {
    recursive: true,
  });
  await mkdir(packages);
  await symlink(outside, path.join(packages, ".covel-install-link"), "dir");
  await symlink(outside, path.join(packages, ".covel-updates"), "dir");
  await writeFile(path.join(packages, ".covel-install-file"), "keep");
  await cleanupPackageStaging(packages);
  await access(path.join(outside, ".covel-install-retained"));
  expect(await readdir(packages)).toHaveLength(3);
});

it("tolerates a fresh installation with no package directories", async () => {
  await cleanupPackageStaging(path.join(root, "missing"));
  expect(await readdir(root)).toEqual([]);
});

it("retries a committed world deletion even when cleanup removed its manifest before failing", async () => {
  const world = path.join(root, "world");
  await mkdir(world);
  await writeFile(path.join(world, "world.yaml"), "id: world\n");
  await writeFile(path.join(world, "WORLD.md"), "Keep until deletion commits");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const commit = vi.fn(async () => {});
  vi.mocked(rm).mockImplementationOnce(async (directory) => {
    expect(commit).toHaveBeenCalledOnce();
    await fs.rm(path.join(String(directory), "package/world.yaml"));
    throw new Error("Synthetic cleanup failure after deleting the manifest");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await deleteWorldPackage(world, commit);
  await expect(access(world)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(root)).toEqual([
    expect.stringMatching(/^\.covel-uninstall-/),
  ]);
  await cleanupPackageStaging(root);
  expect(await readdir(root)).toEqual([]);
});

it("continues startup cleanup after a locked directory and retries it next time", async () => {
  await mkdir(path.join(root, ".covel-install-one"));
  await mkdir(path.join(root, ".covel-install-two"));
  vi.mocked(rm).mockRejectedValueOnce(new Error("Locked staging directory"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await cleanupPackageStaging(root);
  expect(await readdir(root)).toHaveLength(1);
  expect(warn).toHaveBeenCalledOnce();
  await cleanupPackageStaging(root);
  expect(await readdir(root)).toEqual([]);
});
