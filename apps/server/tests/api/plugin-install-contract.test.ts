import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import yazl from "yazl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installRoutes } from "../../src/routes/api/install.js";

let root: string;
let app: Hono;
const repo = "https://github.com/example/probe";
const sha = "a".repeat(40);
const channels = [
  "zip",
  "offline collection",
  "github",
  "github collection",
] as const;
type Channel = (typeof channels)[number];

async function zip(files: Record<string, string>) {
  const archive = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files))
    archive.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  archive.end();
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-install-contract-"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("NODE_ENV", "test");
  app = new Hono();
  app.route("/api/install", installRoutes);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function install(
  channel: Channel,
  dependencies: Record<string, unknown>,
) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "probe",
      version: "1.0.0",
      type: "module",
      ...dependencies,
    }),
    "PLUGIN.md":
      "---\nid: probe\nkind: plugin\ndescription: Test fixture\nentry: ./entry.js\n---\n",
    "entry.js": 'throw new Error("Installer must never import this module");',
  };
  const collection = channel.includes("collection");
  const packaged: Record<string, string> = collection
    ? {
        "covel-collection.yaml": JSON.stringify({
          schemaVersion: 1,
          id: "probe-pack",
          name: "Probe pack",
          plugins: [{ path: "plugins/probe" }],
        }),
        ...Object.fromEntries(
          Object.entries(files).map(([name, content]) => [
            `plugins/probe/${name}`,
            content,
          ]),
        ),
      }
    : files;
  const github = channel.startsWith("github");
  const archive = await zip(
    github
      ? Object.fromEntries(
          Object.entries(packaged).map(([name, content]) => [
            `repo-commit/${name}`,
            content,
          ]),
        )
      : packaged,
  );
  if (!github) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(archive)]), "probe.zip");
    return app.request(`/api/install/${collection ? "collection" : "plugin"}`, {
      method: "POST",
      body: form,
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/commits?")) return Response.json([{ sha }]);
      if (url.startsWith("https://codeload.github.com/"))
        return new Response(new Uint8Array(archive));
      throw new Error(`Unexpected URL: ${url}`);
    }),
  );
  const request = (route: string, body: unknown) =>
    app.request(`/api/install/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const preview = await request(
    collection ? "github/preview" : "plugin/github/preview",
    { url: repo },
  );
  if (preview.status !== 200) return preview;
  const { items } = await preview.json();
  return request(collection ? "github/batch" : "plugin/github", {
    ...(collection
      ? { tokens: items.map((item: { token: string }) => item.token) }
      : { token: items[0].token }),
    acceptRisk: true,
  });
}

it.each(
  channels.flatMap((channel) =>
    ["dependencies", "optionalDependencies", "peerDependencies"].map(
      (field) => ({ channel, field }),
    ),
  ),
)(
  "$channel rejects $field before writing any package",
  async ({ channel, field }) => {
    const response = await install(channel, { [field]: { external: "1.0.0" } });
    expect(response.status).toBe(400);
    const message = await response.text();
    expect(message).toContain(`runtime dependencies in ${field}`);
    expect(message).toContain("self-contained release files");
    expect(message).toContain("devDependencies are allowed");
    expect(await readdir(root)).toEqual([]);
  },
);

it.each(
  channels.flatMap((channel) => [
    { channel, label: "no dependency maps", fields: {} },
    {
      channel,
      label: "empty runtime maps",
      fields: {
        dependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
      },
    },
    {
      channel,
      label: "development tools",
      fields: { devDependencies: { external: "1.0.0" } },
    },
  ]),
)(
  "$channel accepts $label and never runs code or package managers",
  async ({ channel, fields }) => {
    const response = await install(channel, fields);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await readdir(root)).toEqual(["probe"]);
    if (channel === "zip")
      expect(await response.json()).toMatchObject({ hasServerCode: true });
  },
);
