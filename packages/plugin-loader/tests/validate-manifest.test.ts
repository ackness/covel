import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
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
// Runs the validation in this process. A `tsx` child for each check loads the
// loader and its schemas again, and how long that takes depends on the
// machine's load.
async function validate(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runValidateManifest(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
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
    const result = await validate(await fixture({ [field]: "legacy" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(field);
  });
  it("accepts label translations and entry-only contribution packages", async () => {
    const root = await fixture({
      entry: "./server/index.js",
      contributes: {
        ui: { right: ["./ui/panel.json"] },
        prompt: [{ id: "guide", content: "Guidance", position: { depth: 2 } }],
      },
    });
    await mkdir(path.join(root, "locales"));
    await writeFile(
      path.join(root, "locales/zh.yaml"),
      "PLUGIN.md:\n  description: 探针\n",
    );
    const result = await validate(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects a label written as a locale map and a translation it cannot place", async () => {
    const inline = await validate(
      await fixture({ description: { en: "Probe", zh: "探针" } }),
    );
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain("written as a locale map (description)");

    const root = await fixture();
    await mkdir(path.join(root, "locales"));
    await writeFile(
      path.join(root, "locales/zh.yaml"),
      "PLUGIN.md:\n  kind: 插件\n",
    );
    const stray = await validate(root);
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain("kind is not a label");
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
      const result = await validate(target);
      expect(result.status, result.stderr).toBe(0);
    },
  );
  it("rejects root execution alongside a runtimes directory", async () => {
    const root = await fixture({ runtime });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = await validate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime");
  });
  it("rejects package contributions on a child even if equal to the root", async () => {
    const root = await fixture({ contributes: { settings: [] } });
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", {
      ...runtime,
      contributes: { settings: [] },
    });
    const result = await validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contributes");
  });
  it("rejects legacy child PLUGIN.md files", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "PLUGIN.md", runtime);
    const result = await validate(root);
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
    const result = await validate(path.join(root, "runtimes/note/RUNTIME.md"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimes/bad/RUNTIME.md");
  });
  it("validates each package once for overlapping paths", async () => {
    const root = await fixture();
    await write(path.join(root, "runtimes/note"), "RUNTIME.md", runtime);
    const result = await validate(
      root,
      path.join(root, "PLUGIN.md"),
      path.join(root, "runtimes/note/RUNTIME.md"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/✓/g)).toHaveLength(1);
  });
  it("reports missing paths and unsupported flags", async () => {
    expect((await validate("/missing/covel/plugin")).status).toBe(1);
    expect((await validate("--legacy")).status).toBe(2);
  });
  // `pnpm check` runs the script file and reads its exit status, so one check
  // starts it as a process. The child has no time limit of its own: the
  // test's limit is the only one, and `signal` stops the child at that limit.
  it("exits with the validation status when run as a script", async ({
    signal,
  }) => {
    const root = await fixture({ name: "legacy" });
    const result = await new Promise<{ status: number; stderr: string }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", script, root],
          { signal },
          (error, _stdout, stderr) => {
            if (!error) resolve({ status: 0, stderr });
            else if (typeof error.code === "number")
              resolve({ status: error.code, stderr });
            else reject(error);
          },
        );
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("✗");
  });
});
