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
    const root = await fixture(
      "name: probe\ndescription: Metadata\nentry: ./server/index.js",
    );
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

  it.each(["directory", "file"])(
    "accepts shared multi-runtime root declarations via a %s argument",
    async (argumentKind) => {
      const root = await fixture(
        [
          "name: probe",
          "description: Metadata",
          "entry: ./server/index.js",
          "ui: {right: [./ui/panel.json]}",
          "userSettings: []",
          "dataSchemas: {}",
        ].join("\n"),
      );
      await writeManifest(
        path.join(root, "runtimes/panel"),
        "name: probe/panel\ndescription: Panel\nstage: narrative\nui: {right: [./panel.json]}",
      );
      const result = validate(
        argumentKind === "file" ? path.join(root, "PLUGIN.md") : root,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("(multi-runtime root)");
    },
  );

  it("keeps single-runtime declarations valid with an empty runtimes directory", async () => {
    const root = await fixture(
      "name: probe\ndescription: Probe\nui: {right: [./panel.json]}\nuserSettings: []\ndataSchemas: {}",
    );
    await mkdir(path.join(root, "runtimes"));
    const result = validate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects execution fields on a multi-runtime package root", async () => {
    const root = await fixture(
      "name: probe\ndescription: Probe\nstage: narrative",
    );
    await writeManifest(
      path.join(root, "runtimes/run"),
      "name: probe/run\ndescription: Run\nstage: narrative",
    );
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stage: "stage" is an execution field');
  });

  it("rejects conflicting package and runtime settings with source paths", async () => {
    const root = await fixture(
      "name: probe\ndescription: Probe\nuserSettings: [{key: limit, type: number, label: Limit, default: 1}]",
    );
    await writeManifest(
      path.join(root, "runtimes/run"),
      "name: probe/run\ndescription: Run\nstage: narrative\nuserSettings: [{key: limit, type: number, label: Limit, default: 2}]",
    );
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conflicting userSettings");
    expect(result.stderr).toContain(path.join(root, "PLUGIN.md"));
    expect(result.stderr).toContain(path.join(root, "runtimes/run/PLUGIN.md"));
  });

  it("resolves root schemas when validating a child manifest path", async () => {
    const root = await fixture(
      [
        "name: probe",
        "description: Metadata",
        "dataSchemas:",
        "  facts:",
        "    schemaVersion: 1",
        "    acceptsWorldData: true",
        "    schema: ./schemas/facts.schema.json",
      ].join("\n"),
    );
    const child = path.join(root, "runtimes/project/PLUGIN.md");
    await writeManifest(
      path.dirname(child),
      [
        "name: probe/project",
        "description: Project",
        "stage: narrative",
        "worldProjections:",
        "  facts:",
        "    from: covel://world/ir/v1",
        "    handler: ./project.js",
        "    outputs:",
        "      facts: {namespace: facts, key: id}",
      ].join("\n"),
    );

    const result = validate(child);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(2);
  });

  it("rejects sibling conflicts when validating a child manifest path", async () => {
    const root = await fixture(
      "name: probe\ndescription: Metadata\nuserSettings: [{key: limit, type: number, label: Limit, default: 1}]",
    );
    const child = path.join(root, "runtimes/run/PLUGIN.md");
    await writeManifest(
      path.dirname(child),
      "name: probe/run\ndescription: Run\nstage: narrative",
    );
    const sibling = path.join(root, "runtimes/other/PLUGIN.md");
    await writeManifest(
      path.dirname(sibling),
      "name: probe/other\ndescription: Other\nstage: narrative\nuserSettings: [{key: limit, type: number, label: Limit, default: 2}]",
    );

    const result = validate(child);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conflicting userSettings");
    expect(result.stderr).toContain(path.join(root, "PLUGIN.md"));
    expect(result.stderr).toContain(sibling);
  });

  it("checks package layout when validating a child manifest path", async () => {
    const root = await fixture(
      "name: probe\ndescription: Metadata\nstage: narrative",
    );
    const child = path.join(root, "runtimes/run/PLUGIN.md");
    await writeManifest(
      path.dirname(child),
      "name: probe/run\ndescription: Run\nstage: narrative",
    );

    const result = validate(child);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("(multi-runtime root)");
  });

  it("validates each package only once for overlapping paths", async () => {
    const root = await fixture("name: probe\ndescription: Metadata");
    const child = path.join(root, "runtimes/run/PLUGIN.md");
    await writeManifest(
      path.dirname(child),
      "name: probe/run\ndescription: Run\nstage: narrative",
    );

    const result = validate(root, child);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(2);
  });

  it("rejects package-only declarations in a runtime directory", async () => {
    const root = await fixture("name: probe\ndescription: Probe");
    await writeManifest(
      path.join(root, "runtimes/panel"),
      "name: probe/panel\ndescription: Panel\nui: {right: [./panel.json]}",
    );
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "runtime declaration requires execution fields",
    );
  });

  it("has no flag that bypasses the current authoring contract", async () => {
    const root = await fixture(
      "name: probe\ndescription: Probe\ntrigger: {type: auto}",
    );
    const result = validate(root, "--compat");
    expect(result.status).not.toBe(0);
  });
});
