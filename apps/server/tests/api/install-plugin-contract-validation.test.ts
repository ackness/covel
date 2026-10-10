import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import { installRoutes } from "../../src/routes/api/install.js";

const md = (value: object) => `---\n${JSON.stringify(value)}\n---\nPrompt`;
let tempRoot: string;
let pluginsDir: string;
beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "covel-install-contracts-"));
  pluginsDir = path.join(tempRoot, "plugins");
  await mkdir(pluginsDir);
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", pluginsDir);
  vi.stubEnv("COVEL_PLUGINS_DIR", "");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("COVEL_INSTALL_API_ENABLED", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempRoot, { recursive: true, force: true });
});

async function install(
  layout: "inline" | "child",
  binding: object,
  files: Record<string, string> = {},
) {
  const runtimeDir = layout === "inline" ? "" : "runtimes/consumer/";
  const runtime = {
    type: "function",
    schedule: { trigger: { type: "manual" } },
    function: { handler: "./handler.js" },
    guard: "./guard.js",
    io: { inputs: { prior: binding } },
  };
  const entries: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "@covel/plugin-probe",
      version: "1.0.0",
      type: "module",
    }),
    "PLUGIN.md": md({
      id: "probe",
      kind: "plugin",
      version: "1.0.0",
      description: "Probe",
      entry: "./entry.js",
      optional: ["external.output@1"],
      ...(layout === "inline" ? { runtime } : {}),
    }),
  };
  if (layout === "child") entries[`${runtimeDir}RUNTIME.md`] = md(runtime);
  const code = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path.join(tempRoot, "executed"))}, 'executed'); throw new Error('Community code executed');`;
  entries["entry.js"] = code;
  entries[`${runtimeDir}handler.js`] = code;
  entries[`${runtimeDir}guard.js`] = code;
  for (const [name, content] of Object.entries(files))
    entries[`${runtimeDir}${name}`] = content;
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), name);
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    zip.end();
  });
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: "application/zip" }),
    "probe.zip",
  );
  const app = new Hono();
  app.route("/api/install", installRoutes);
  return app.request("/api/install/plugin", { method: "POST", body: form });
}

for (const layout of ["inline", "child"] as const) {
  const runtimeId = layout === "inline" ? "probe" : "probe/consumer";
  const committed = {
    from: { runtime: runtimeId },
    scope: "committed",
    recordAs: "facts",
  };
  describe(`plugin ZIP ${layout} committed input validation`, () => {
    it.each<{
      name: string;
      binding: object;
      field: string;
      files: Record<string, string>;
    }>([
      {
        name: "missing accepts",
        binding: { ...committed, accepts: "./missing.json" },
        field: "io.inputs.prior.accepts",
        files: {},
      },
      {
        name: "malformed accepts JSON",
        binding: { ...committed, accepts: "./invalid.json" },
        field: "io.inputs.prior.accepts",
        files: { "invalid.json": "not JSON" },
      },
      {
        name: "missing same-package producer",
        binding: { ...committed, from: { runtime: "probe/missing" } },
        field: "io.inputs.prior",
        files: {},
      },
      {
        name: "committed select",
        binding: { ...committed, select: "/value" },
        field: "io.inputs.prior.select",
        files: {},
      },
      {
        name: "committed empty select",
        binding: { ...committed, select: "" },
        field: "io.inputs.prior.select",
        files: {},
      },
    ])(
      "rejects $name before writing any package files or executing code",
      async ({ binding, field, files }) => {
        const response = await install(layout, binding, files);
        const body = await response.text();
        expect(response.status, body).toBe(400);
        expect(body).toContain(
          layout === "inline" ? "PLUGIN.md" : "runtimes/consumer/RUNTIME.md",
        );
        expect(body).toContain(field);
        expect(await readdir(pluginsDir)).toEqual([]);
        await expect(access(path.join(tempRoot, "executed"))).rejects.toThrow();
      },
    );
    it.each([
      {
        name: "local committed schema",
        binding: { ...committed, accepts: "./valid.json" },
      },
      {
        name: "optional external committed contract",
        binding: {
          from: { contract: "external.output@1" },
          scope: "committed",
          recordAs: "facts",
          required: false,
          accepts: "contract:external.output@1",
        },
      },
      {
        name: "normal turn select",
        binding: {
          from: { runtime: runtimeId },
          select: "/value",
          accepts: "./valid.json",
        },
      },
    ])(
      "installs $name without executing community code",
      async ({ binding }) => {
        const response = await install(layout, binding, { "valid.json": "{}" });
        expect(response.status, await response.text()).toBe(201);
        await expect(access(path.join(tempRoot, "executed"))).rejects.toThrow();
      },
    );
  });
}
