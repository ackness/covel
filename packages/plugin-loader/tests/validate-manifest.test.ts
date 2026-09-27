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
async function fixture(fields: Record<string, unknown> = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-authoring-"));
  roots.push(temp);
  const root = path.join(temp, "probe");
  await write(root, "PLUGIN.md", {
    id: "probe",
    kind: "plugin",
    description: "Probe",
    ...fields,
  });
  return root;
}
async function write(root: string, filename: string, value: unknown) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, filename),
    `---\n${JSON.stringify(value)}\n---\n`,
    "utf8",
  );
}
function validate(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}
const runtime = {
  type: "function",
  function: { handler: "./handler.js", timeoutMs: 90_000 },
  schedule: { trigger: { type: "manual" } },
};
describe("manifest authoring CLI", () => {
  it.each([
    "name",
    "stage",
    "capabilities",
    "authorsNote",
    "postHistory",
    "userSettings",
  ])("rejects legacy root field %s", async (field) => {
    const result = validate(await fixture({ [field]: "legacy" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(field);
  });
  it("accepts localized metadata and entry-only contribution packages", async () => {
    const root = await fixture({
      description: { en: "Probe", zh: "探针" },
      entry: "./server/index.js",
      contributes: {
        ui: { right: ["./ui/panel.json"] },
        prompt: [{ id: "guide", content: "Guidance", position: { depth: 2 } }],
      },
    });
    const result = validate(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["directory", "root", "child"])(
    "validates all runtime declarations through a %s path",
    async (kind) => {
      const root = await fixture();
      await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
      await write(path.join(root, "runtimes/listener"), "RUNTIME.md", {
        ...runtime,
        schedule: { trigger: { type: "event", topic: "note.created" } },
      });
      const target =
        kind === "directory"
          ? root
          : kind === "root"
            ? path.join(root, "PLUGIN.md")
            : path.join(root, "runtimes/note/RUNTIME.md");
      const result = validate(target);
      expect(result.status, result.stderr).toBe(0);
    },
  );
  it("rejects root execution alongside a runtimes directory", async () => {
    const root = await fixture({ runtime });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime");
  });
  it("rejects package contributions on a child even if equal to the root", async () => {
    const root = await fixture({ contributes: { settings: [] } });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", {
      ...runtime,
      contributes: { settings: [] },
    });
    const result = validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contributes");
  });
  it("rejects legacy child PLUGIN.md files", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "PLUGIN.md", runtime);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RUNTIME.md");
  });
  it("validates sibling declarations when passed a child path", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    await write(path.join(root, "runtimes/bad"), "RUNTIME.md", {
      ...runtime,
      type: "unknown",
    });
    const result = validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimes/bad/RUNTIME.md");
  });
  it("validates each package once for overlapping paths", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = validate(
      root,
      path.join(root, "PLUGIN.md"),
      path.join(root, "runtimes/note/RUNTIME.md"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(1);
  });
  it("reports missing paths and unsupported flags", () => {
    expect(validate("/missing/covel/plugin").status).toBe(1);
    expect(validate("--legacy").status).toBe(2);
  });
});
