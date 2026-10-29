import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  checkPackageIntegrity,
  readReceipt,
  readUnmodifiedPackage,
} from "../../src/routes/api/install/package-files.js";
import {
  inspectBundle,
  receiptEntry,
  signPreview,
  verifyPreview,
} from "../../src/routes/api/install/github-preview.js";
import { computePluginCapabilities } from "@covel/plugin-loader";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";
import { packageFixture } from "./fixtures.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-integrity-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("verifies untouched contents and round-trips snapshots", async () => {
  const fixture = await packageFixture(root);
  expect(await checkPackageIntegrity(fixture.directory)).toMatchObject({
    status: "verified",
    files: ["PLUGIN.md"],
    receipt: { capabilities: fixture.capabilities },
  });
  expect((await readReceipt(fixture.directory)).capabilities).toEqual(
    fixture.capabilities,
  );
});
it.each(["edit", "add", "delete", "link", "directory"])(
  "marks %s as modified",
  async (change) => {
    const fixture = await packageFixture(root);
    if (change === "edit")
      await writeFile(path.join(fixture.directory, "PLUGIN.md"), "changed");
    if (change === "add")
      await writeFile(path.join(fixture.directory, "extra.txt"), "new");
    if (change === "delete")
      await rm(path.join(fixture.directory, "PLUGIN.md"));
    if (change === "link")
      await symlink("PLUGIN.md", path.join(fixture.directory, "link"));
    if (change === "directory") {
      await mkdir(path.join(fixture.directory, "extra"));
      await writeFile(path.join(fixture.directory, "extra/new.txt"), "new");
    }
    expect((await checkPackageIntegrity(fixture.directory)).status).toBe(
      "modified",
    );
  },
);
it("distinguishes missing and unreadable receipts and enforces strict metadata", async () => {
  const fixture = await packageFixture(root);
  await rm(fixture.receiptPath);
  expect(await checkPackageIntegrity(fixture.directory)).toEqual({
    status: "no-receipt",
  });
  for (const contents of [
    "{",
    JSON.stringify({
      ...JSON.parse(receiptEntry(fixture.preview).content.toString()),
      unknown: true,
    }),
  ]) {
    await writeFile(fixture.receiptPath, contents);
    expect((await checkPackageIntegrity(fixture.directory)).status).toBe(
      "unreadable",
    );
  }
});
it("installs only previewed trusted snapshots, carries them unchanged on update, and never snapshots worlds", async () => {
  const fixture = await packageFixture(root);
  const decode = (content: Buffer) => JSON.parse(content.toString());
  expect(decode(receiptEntry(fixture.preview).content).capabilities).toEqual(
    fixture.preview.capabilities,
  );
  expect(
    decode(receiptEntry({ ...fixture.preview, trustedSource: false }).content),
  ).not.toHaveProperty("capabilities");
  const previous = await readReceipt(fixture.directory);
  const growth = {
    ...fixture.preview,
    capabilities: { ...fixture.capabilities, tools: ["new"] },
  };
  expect(decode(receiptEntry(growth, previous).content).capabilities).toEqual(
    fixture.capabilities,
  );
  const { capabilities: _snapshot, ...withoutSnapshot } = previous;
  expect(
    decode(receiptEntry(growth, withoutSnapshot).content),
  ).not.toHaveProperty("capabilities");
  expect(
    decode(receiptEntry(fixture.preview, undefined, "world").content),
  ).not.toHaveProperty("capabilities");
  const { token: _token, ...signedPlugin } = growth;
  const token = signPreview({
    action: "update",
    plugin: signedPlugin,
    previous,
  });
  expect(verifyPreview(token)).toMatchObject({
    plugin: { capabilities: growth.capabilities, trustedSource: true },
    previous,
  });
});
it("rejects an update preview after a snapshot rewrite", async () => {
  const fixture = await packageFixture(root, { snapshot: null });
  const previous = await readReceipt(fixture.directory);
  await writeFile(
    fixture.receiptPath,
    JSON.stringify({ ...previous, capabilities: fixture.capabilities }),
  );
  await expect(
    readUnmodifiedPackage(fixture.directory, previous),
  ).rejects.toMatchObject({
    httpStatus: 409,
    message: "Installed package changed; check for updates again",
  });
});
it("computes the same capabilities at installation and registry time", async () => {
  const fixture = await packageFixture(root, {
    manifest: { entry: "./server.js", contributes: { tools: ["probe"] } },
    files: { "server.js": "export default function register() {}" },
  });
  const bundle = validatePluginBundle(fixture.entries, new Set());
  expect(inspectBundle(fixture.entries, new Set()).capabilities).toEqual(
    computePluginCapabilities({
      root: bundle.manifest,
      runtimes: bundle.declarations,
      hasServerCode: bundle.hasServerCode,
    }),
  );
  expect(bundle.capabilities).toEqual(fixture.capabilities);
  expect(await readdir(fixture.directory)).toContain("server.js");
  expect(await readFile(fixture.receiptPath, "utf8")).toContain("capabilities");
});
