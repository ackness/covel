import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import yazl from "yazl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { installRoutes } from "../../src/routes/api/install.js";
import {
  applyPendingPackageUpdates,
  pendingPackagePath,
} from "../../src/routes/api/install/package-updates.js";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { configureOutboundProxy } from "@covel/ai-provider";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const first = "a".repeat(40);
const second = "b".repeat(40);
const repo = "https://github.com/example/plugins";
let root: string;
let app: Hono;
let head: string;
let branchExists: boolean;
let archives: Map<string, Buffer>;
let fetchMock: ReturnType<typeof vi.fn>;
function files(version: string) {
  return {
    "plugins/note/package.json": JSON.stringify({
      name: "example-note",
      version,
      type: "module",
    }),
    "plugins/note/PLUGIN.md":
      "---\nname: example-note\npluginType: plugin\ndescription: Update fixture\noutputKind: system\nentry: ./server.js\n---\n",
    "plugins/note/server.js": `throw new Error("Unapproved ${version} code executed");`,
    "README.md": "Repository description",
  };
}
async function zip(entries: Record<string, string>) {
  const archive = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    archive.addBuffer(Buffer.from(content), `repo/${name}`);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  archive.end();
  return result;
}
const request = (route: string, body?: unknown, method = "POST") =>
  app.request(`/api/install/${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function install(url = repo) {
  const response = await request("plugin/github/preview", { url });
  expect(response.status).toBe(200);
  const { items } = await response.json();
  expect(
    (
      await request("plugin/github", {
        token: items[0].token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(201);
  return items[0];
}
async function updatePreview(url?: string) {
  const response = await request("plugin/github/update/preview", {
    id: "example-note",
    ...(url ? { url } : {}),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
async function queue() {
  const result = await updatePreview();
  expect(result.status).toBe("available");
  const response = await request("plugin/github/update", {
    token: result.preview.token,
    acceptRisk: true,
  });
  expect(response.status, await response.text()).toBe(201);
  return result.preview;
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "covel-update-test-"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("NODE_ENV", "test");
  head = first;
  branchExists = true;
  archives = new Map([
    [first, await zip(files("1.0.0"))],
    [second, await zip(files("1.1.0"))],
  ]);
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("reservedPluginIds", new Set(["narrator"]));
    await next();
  });
  app.route("/api/install", installRoutes);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    if (url.includes("/branches/"))
      return url.endsWith("/main") && branchExists
        ? Response.json({ commit: { sha: head } })
        : new Response(null, { status: 404 });
    if (url.endsWith("/commits?per_page=1"))
      return Response.json([{ sha: head }]);
    if (url.endsWith("/commits/v1")) return Response.json({ sha: first });
    if (url.endsWith("/commits/v2") || url.endsWith(`/commits/${second}`))
      return Response.json({ sha: second });
    if (url.startsWith("https://codeload.github.com/example/plugins/zip/"))
      return new Response(
        new Uint8Array(archives.get(url.split("/").at(-1)!)!),
      );
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  configureOutboundProxy({ mode: "direct" });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("ignores repository-only changes, stages selected files and applies before discovery without executing code", async () => {
  archives.set(
    first,
    await zip({ ...files("1.0.0"), "plugins/note/obsolete.txt": "old" }),
  );
  await install();
  head = second;
  archives.set(
    second,
    await zip({
      ...files("1.0.0"),
      "plugins/note/obsolete.txt": "old",
      "README.md": "Different repository description",
      "plugins/other/data.txt": "Other package",
    }),
  );
  expect(await updatePreview()).toEqual({ status: "current" });
  archives.set(
    second,
    await zip({ ...files("1.1.0"), "plugins/note/new.txt": "new" }),
  );
  const preview = await queue();
  expect(preview.changes).toEqual({
    added: ["new.txt"],
    modified: ["package.json", "server.js"],
    removed: ["obsolete.txt"],
  });
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.0.0");
  const before = await (await request("plugins", undefined, "GET")).json();
  expect(before.items[0]).toMatchObject({
    version: "1.0.0",
    pendingUpdate: { version: "1.1.0", error: null },
  });
  const boot = await discoverAndRegisterPlugins({
    pluginsDir: path.join(root, "missing-builtin"),
    pluginsDirs: [path.join(root, "missing-builtin"), root],
    eventBus: createEventBus(),
  });
  expect(boot.registry.get("example-note")?.source).toBe("community");
  expect(boot.registry.get("example-note")?.status).toBe("registered");
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.1.0");
  expect((await readdir(path.join(root, "example-note"))).sort()).toEqual([
    ".covel-install.json",
    "PLUGIN.md",
    "new.txt",
    "package.json",
    "server.js",
  ]);
  const after = await (await request("plugins", undefined, "GET")).json();
  expect(after.items[0]).toMatchObject({
    version: "1.1.0",
    pendingUpdate: null,
  });
});

it("tracks explicit branches but pins tags until the user selects a version in the same package", async () => {
  const item = await install(`${repo}/tree/v1/plugins/note`);
  expect(item.source.tracking).toEqual({ kind: "pinned", ref: "v1" });
  head = second;
  const calls = fetchMock.mock.calls.length;
  expect(await updatePreview()).toEqual({ status: "pinned" });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  const selected = await updatePreview(`${repo}/tree/v2/plugins/note`);
  expect(selected.preview.source.tracking).toEqual({
    kind: "pinned",
    ref: "v2",
  });
  const branch = await updatePreview(`${repo}/tree/main/plugins/note`);
  expect(branch.preview.source.tracking).toEqual({
    kind: "branch",
    ref: "main",
  });
  for (const url of [
    `${repo}/tree/main/plugins/other`,
    "https://github.com/another/plugins/tree/main/plugins/note",
  ])
    expect(
      (
        await request("plugin/github/update/preview", {
          id: "example-note",
          url,
        })
      ).status,
    ).toBe(409);
});

it("does not follow a deleted tracked branch as a tag", async () => {
  await install(`${repo}/tree/main/plugins/note`);
  branchExists = false;
  fetchMock.mockImplementation(async (url: string) =>
    url.includes("/branches/")
      ? new Response(null, { status: 404 })
      : Response.json({ sha: second }),
  );
  const response = await request("plugin/github/update/preview", {
    id: "example-note",
  });
  expect(response.status).toBe(409);
});

it("requires separate update consent and rejects install tokens, tampering, expiry, and duplicate queues", async () => {
  const installed = await install();
  head = second;
  const { preview } = await updatePreview();
  expect(
    (await request("plugin/github/update", { token: preview.token })).status,
  ).toBe(400);
  expect(
    (
      await request("plugin/github/update", {
        token: installed.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("plugin/github", { token: preview.token, acceptRisk: true }))
      .status,
  ).toBe(400);
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token + "x",
        acceptRisk: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(409);
  expect(
    (await request("plugin/github/update/example-note", undefined, "DELETE"))
      .status,
  ).toBe(200);
  vi.useFakeTimers();
  vi.setSystemTime(preview.expiresAt + 1);
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(409);
});

it.each(["modified", "added", "deleted", "link"])(
  "blocks %s local files without changing the installation",
  async (kind) => {
    await install();
    head = second;
    const { preview } = await updatePreview();
    const file = path.join(root, "example-note/server.js");
    if (kind === "modified") await writeFile(file, "Local change");
    if (kind === "added")
      await writeFile(path.join(root, "example-note/local-data.json"), "{}");
    if (kind === "deleted") await rm(file);
    if (kind === "link") {
      await rm(file);
      await symlink(path.join(root, "example-note/package.json"), file);
    }
    expect(
      (
        await request("plugin/github/update", {
          token: preview.token,
          acceptRisk: true,
        })
      ).status,
    ).toBe(409);
    expect(
      await readFile(path.join(root, "example-note/package.json"), "utf8"),
    ).toContain("1.0.0");
  },
);

it("rechecks local edits at startup and supports cancelling the failed queued update", async () => {
  await install();
  head = second;
  await queue();
  const file = path.join(root, "example-note/server.js");
  await writeFile(file, "Later local edit");
  await applyPendingPackageUpdates(root);
  expect(await readFile(file, "utf8")).toBe("Later local edit");
  const list = await (await request("plugins", undefined, "GET")).json();
  expect(list.items[0].pendingUpdate.error).toContain("modified locally");
  expect(
    (await request("plugin/github/update/example-note", undefined, "DELETE"))
      .status,
  ).toBe(200);
  expect(await readdir(path.join(root, ".covel-updates"))).toEqual([]);
});

it("restores the old package when promotion fails, then retries safely", async () => {
  await install();
  head = second;
  await queue();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith("/package"))
      throw Object.assign(new Error("Synthetic promotion failure"), {
        code: "EACCES",
      });
    await actual.rename(from, to);
  });
  await applyPendingPackageUpdates(root);
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.0.0");
  vi.mocked(rename).mockImplementation(actual.rename);
  await applyPendingPackageUpdates(root);
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.1.0");
});

it.each(["before-promotion", "after-promotion"])(
  "recovers an interrupted %s transaction",
  async (stage) => {
    await install();
    head = second;
    await queue();
    const directory = pendingPackagePath(root, "example-note");
    await rename(
      path.join(root, "example-note"),
      path.join(directory, "previous"),
    );
    if (stage === "after-promotion")
      await rename(
        path.join(directory, "package"),
        path.join(root, "example-note"),
      );
    await applyPendingPackageUpdates(root);
    expect(
      await readFile(path.join(root, "example-note/package.json"), "utf8"),
    ).toContain("1.1.0");
    expect(await readdir(path.join(root, ".covel-updates"))).toEqual([]);
  },
);

it("uses the configured proxy for update resolution and both downloads", async () => {
  await install();
  head = second;
  configureOutboundProxy({ mode: "http", url: "http://127.0.0.1:7890" });
  fetchMock.mockClear();
  await queue();
  expect(fetchMock.mock.calls).toHaveLength(3);
  for (const [, options] of fetchMock.mock.calls)
    expect(options.dispatcher.constructor.name).toBe("ProxyAgent");
});

it("rejects changes to the installation receipt or remote archive after preview", async () => {
  await install();
  head = second;
  const { preview } = await updatePreview();
  const receiptPath = path.join(root, "example-note/.covel-install.json");
  const original = await readFile(receiptPath, "utf8");
  const receipt = JSON.parse(original);
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, installedAt: "2020-01-01T00:00:00.000Z" }),
  );
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(409);
  await writeFile(receiptPath, original);
  archives.set(second, await zip(files("unexpected-change")));
  expect(
    (
      await request("plugin/github/update", {
        token: preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(409);
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.0.0");
});

it("admits only one concurrent update transaction", async () => {
  await install();
  head = second;
  const { preview } = await updatePreview();
  const responses = await Promise.all([
    request("plugin/github/update", { token: preview.token, acceptRisk: true }),
    request("plugin/github/update", { token: preview.token, acceptRisk: true }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  await applyPendingPackageUpdates(root);
  expect(
    await readFile(path.join(root, "example-note/package.json"), "utf8"),
  ).toContain("1.1.0");
});
