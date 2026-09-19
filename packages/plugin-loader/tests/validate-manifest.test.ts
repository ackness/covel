import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(
  import.meta.dirname,
  "../scripts/validate-manifest.ts",
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(frontmatter: string) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "covel-manifest-authoring-"),
  );
  roots.push(root);
  await writeManifest(root, frontmatter);
  return root;
}

async function writeManifest(root: string, frontmatter: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "PLUGIN.md"),
    `---\n${frontmatter}\n---\n`,
    "utf8",
  );
}

function validate(root: string, ...options: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", script, root, ...options],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("manifest authoring CLI", () => {
  it.each([
    ["authorsNote: {content: valid, depth: wrong}", "authorsNote.depth"],
    ["postHistory: {content: valid, role: wrong}", "postHistory.role"],
  ])("rejects raw invalid fields: %s", async (field, issuePath) => {
    const root = await fixture(`name: probe\ndescription: Probe\n${field}`);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("(authoring schema)");
    expect(result.stderr).toContain(issuePath);
  });

  it("accepts localized metadata and Hook/UI-only plugin declarations", async () => {
    const root = await fixture(
      [
        "name: probe",
        "description: {en: Probe, zh: 探针}",
        "displayName: {en: Probe, zh: 探针}",
        "entry: ./server/index.js",
        "ui: {right: [./ui/panel.json]}",
        "authorsNote: {content: Guidance, depth: 2, role: system}",
        "postHistory: {content: Reminder, role: user}",
      ].join("\n"),
    );
    const result = validate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts metadata roots and validates every runtime in a package", async () => {
    const root = await fixture("name: probe\ndescription: Metadata");
    await writeManifest(
      path.join(root, "runtimes/note"),
      [
        "name: probe/note",
        "description: Note",
        "runtimeType: function",
        "handler: ./handler.js",
        "trigger: {type: manual}",
      ].join("\n"),
    );
    await writeManifest(
      path.join(root, "runtimes/listener"),
      [
        "name: probe/listener",
        "description: Listener",
        "runtimeType: function",
        "handler: ./handler.js",
        "trigger: {type: event, topic: note.created}",
      ].join("\n"),
    );
    const result = validate(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(3);
  });

  it("has no flag that bypasses the current authoring contract", async () => {
    const root = await fixture(
      "name: probe\ndescription: Probe\ntrigger: {type: auto}",
    );
    const result = validate(root, "--compat");
    expect(result.status).not.toBe(0);
  });
});
