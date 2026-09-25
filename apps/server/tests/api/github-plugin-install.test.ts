import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubPluginPreview } from "@covel/shared";
import { installRoutes } from "../../src/routes/api/install.js";
import { parseGithubUrl } from "../../src/routes/api/install/github-source.js";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { configureOutboundProxy } from "@covel/ai-provider";
import { createConfigApiRoutes } from "../../src/routes/config-api.js";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const sha = "a".repeat(40);
const repo = "https://github.com/example/plugins";
const fixture = {
  "package.json": JSON.stringify({
    name: "example-note",
    version: "1.0.0",
    type: "module",
  }),
  "PLUGIN.md":
    "---\nname: example-note\npluginType: plugin\ndescription: Synthetic hook plugin\noutputKind: system\nentry: ./server/index.js\n---\n",
  // Importing the module is forbidden during preview, install and discovery.
  "server/index.js":
    'throw new Error("Unapproved code executed");\nexport default function register() {}\n',
};
async function zip(files: Record<string, string>, prefix = "plugins-commit/") {
  const archive = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files))
    archive.addBuffer(Buffer.from(content), prefix + name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  archive.end();
  return result;
}

let root: string;
let app: Hono;
let archive: Buffer;
let fetchMock: ReturnType<typeof vi.fn>;
function request(
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/install/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function preview(url = repo): Promise<GithubPluginPreview> {
  const response = await request("plugin/github/preview", { url });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.items[0];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-github-test-"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("NODE_ENV", "test");
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("reservedPluginIds", new Set(["narrator"]));
    await next();
  });
  app.route("/api/install", installRoutes);
  archive = await zip(fixture);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (
      url === "https://api.github.com/repos/example/plugins/commits?per_page=1"
    )
      return Response.json([{ sha }]);
    if (url === "https://api.github.com/repos/example/plugins/commits/v1")
      return Response.json({ sha });
    if (url === `https://codeload.github.com/example/plugins/zip/${sha}`)
      return new Response(new Uint8Array(archive));
    throw new Error(`Unexpected URL: ${url}`);
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

describe("GitHub plugin installation", () => {
  it("previews without disk writes, installs pinned content and records it before restart", async () => {
    const item = await preview();
    expect(item).toMatchObject({
      id: "example-note",
      hasServerCode: true,
      version: "1.0.0",
      source: { repository: repo, commit: sha, path: "" },
    });
    expect(await readdir(root)).toEqual([]);
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(201);
    expect(
      await readFile(path.join(root, "example-note/server/index.js"), "utf8"),
    ).toBe(fixture["server/index.js"]);
    const receipt = JSON.parse(
      await readFile(
        path.join(root, "example-note/.covel-install.json"),
        "utf8",
      ),
    );
    expect(receipt.source).toEqual(item.source);
    expect(await (await request("plugins")).json()).toMatchObject({
      items: [{ id: "example-note", source: item.source, version: "1.0.0" }],
    });
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(409);
    expect(await readdir(root)).toEqual(["example-note"]);
    const builtin = path.join(root, ".builtin");
    await mkdir(builtin);
    const discovered = await discoverAndRegisterPlugins({
      pluginsDir: builtin,
      pluginsDirs: [builtin, root],
      eventBus: createEventBus(),
    });
    expect(discovered.registry.get("example-note")).toMatchObject({
      status: "registered",
      source: "community",
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.startsWith("https://api.github.com"),
      ),
    ).toHaveLength(1);
  });

  it("enables a hook-only installed plugin only after a separate session approval", async () => {
    archive = await zip({
      ...fixture,
      "server/index.js": `
      import { writeFileSync } from "node:fs";
      export default function register(covel) {
        writeFileSync(new URL("../activated.txt", import.meta.url), "approved");
        covel.on("PostContextAssembly", (_ctx, payload) => payload.outputKind === "story"
          ? { action: "continue", replace: { systemPrompt: payload.systemPrompt + " note" } }
          : { action: "continue" });
      }
    `,
    });
    const item = await preview();
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(201);
    const marker = path.join(root, "example-note/activated.txt");
    const builtin = path.join(root, ".builtin");
    await mkdir(builtin);
    const store = createMemoryStore();
    await store.createSession({
      id: "hook-session",
      worldId: null,
      phase: "playing",
      setupRuntimes: {},
      status: "active",
      completedPlayerTurns: 0,
      activePlugins: [],
      locale: "en-US",
      createdAt: new Date().toISOString(),
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
    });
    const boot = await bootstrapApi({
      pluginsDir: builtin,
      pluginsDirs: [builtin, root],
      store,
      storeBackend: "memory",
    });
    try {
      expect(boot.registry.get("example-note")?.source).toBe("community");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const enable = () =>
        boot.app.request("/api/sessions/hook-session/plugins/example-note", {
          method: "PUT",
        });
      const pending = await enable();
      expect(pending.status).toBe(202);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const { approvalId } = await pending.json();
      const approved = await boot.app.request(
        `/api/approvals/${approvalId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow", scope: "session" }),
        },
      );
      expect(approved.status, await approved.clone().text()).toBe(200);
      expect(await readFile(marker, "utf8")).toBe("approved");
      expect((await enable()).status).toBe(200);
      expect((await store.getSession("hook-session"))?.activePlugins).toContain(
        "example-note",
      );
    } finally {
      await closeTestApi(boot);
    }
  });

  it("uses hot-applied HTTP and SOCKS settings for metadata and both archive downloads", async () => {
    vi.stubEnv("COVEL_HOME", root);
    const config = createConfigApiRoutes({ apiKeys: {} });
    const update = (mode: string, url: string) =>
      config.request("/api/config/proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, url }),
      });
    expect((await update("http", "http://127.0.0.1:7890")).status).toBe(200);
    const item = await preview();
    const firstDispatcher = (
      fetchMock.mock.calls[0]![1] as RequestInit & { dispatcher: object }
    ).dispatcher;
    expect(firstDispatcher.constructor.name).toBe("ProxyAgent");
    expect(
      (fetchMock.mock.calls[1]![1] as RequestInit & { dispatcher: object })
        .dispatcher,
    ).toBe(firstDispatcher);
    expect((await update("socks", "socks5://127.0.0.1:7891")).status).toBe(200);
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(201);
    const nextDispatcher = (
      fetchMock.mock.calls[2]![1] as RequestInit & { dispatcher: object }
    ).dispatcher;
    expect(nextDispatcher.constructor.name).toBe("ProxyAgent");
    expect(nextDispatcher).not.toBe(firstDispatcher);
  });

  it("resolves the system proxy separately for GitHub API and codeload", async () => {
    const resolveSystemProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    configureOutboundProxy({ mode: "system", resolveSystemProxy });
    const item = await preview();
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(201);
    expect(resolveSystemProxy.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/example/plugins/commits?per_page=1",
      `https://codeload.github.com/example/plugins/zip/${sha}`,
      `https://codeload.github.com/example/plugins/zip/${sha}`,
    ]);
  });

  it("reports an explicit proxy failure without retrying directly", async () => {
    configureOutboundProxy({ mode: "http", url: "http://127.0.0.1:7890" });
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Proxy connection refused"), {
        code: "ECONNREFUSED",
      }),
    );
    const response = await request("plugin/github/preview", { url: repo });
    expect(response.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["PLUGIN.md", "PLUGIN.en.md", "runtimes/hidden/PLUGIN.fr.md"])(
    "rejects executable frontmatter in %s without evaluating it",
    async (filename) => {
      const marker = "__covelInstallEvaluated";
      archive = await zip({
        ...fixture,
        [filename]: `---javascript\n(globalThis.${marker} = true, {name: "example-note"})\n---\n`,
      });
      expect(
        (await request("plugin/github/preview", { url: repo })).status,
      ).toBe(400);
      expect(Reflect.get(globalThis, marker)).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("requires explicit risk acceptance and rejects tampered or expired previews", async () => {
    const item = await preview();
    const calls = fetchMock.mock.calls.length;
    expect((await request("plugin/github", { token: item.token })).status).toBe(
      400,
    );
    expect(
      (
        await request("plugin/github", {
          token: item.token + "x",
          acceptRisk: true,
        })
      ).status,
    ).toBe(400);
    vi.useFakeTimers();
    vi.setSystemTime(item.expiresAt + 1);
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(409);
    expect(fetchMock.mock.calls).toHaveLength(calls);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a changed archive without installing any files", async () => {
    const item = await preview();
    archive = await zip({ ...fixture, "README.md": "changed" });
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(409);
    expect(await readdir(root)).toEqual([]);
  });

  it("selects a subdirectory at a tag and supports multi-runtime layouts", async () => {
    archive = await zip({
      "plugins/note/package.json": fixture["package.json"],
      "plugins/note/runtimes/one/PLUGIN.md":
        "---\nname: example-note/one\npluginType: plugin\ndescription: One\ntrigger: { type: manual }\n---\n",
      "plugins/note/runtimes/two/PLUGIN.md":
        "---\nname: example-note/two\npluginType: plugin\ndescription: Two\ntrigger: { type: manual }\n---\n",
      "outside.txt": "must not install",
    });
    const item = await preview(`${repo}/tree/v1/plugins/note`);
    expect(item.source.path).toBe("plugins/note");
    expect(
      (await request("plugin/github", { token: item.token, acceptRisk: true }))
        .status,
    ).toBe(201);
    expect(await readdir(path.join(root, "example-note"))).not.toContain(
      "outside.txt",
    );
    expect(
      await readFile(
        path.join(root, "example-note/runtimes/two/PLUGIN.md"),
        "utf8",
      ),
    ).toContain("example-note/two");
  });

  it("discovers repository or folder packages and installs them independently", async () => {
    archive = await zip({
      "package.json": JSON.stringify({
        private: true,
        devDependencies: { build: "1" },
      }),
      "README.md": "Repository tooling must not be installed",
      ...Object.fromEntries(
        Object.entries(fixture).flatMap(([name, content]) => [
          [`plugins/first/${name}`, content],
          [
            `plugins/second/${name}`,
            content.replaceAll("example-note", "second-note"),
          ],
          [
            `examples/demo/${name}`,
            content.replaceAll("example-note", "demo-note"),
          ],
          [`node_modules/ignored/${name}`, content],
          [`.hidden/ignored/${name}`, content],
        ]),
      ),
    });
    const response = await request("plugin/github/preview", { url: repo });
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as {
      items: GithubPluginPreview[];
    };
    expect(items.map((item) => [item.id, item.source.path])).toEqual([
      ["demo-note", "examples/demo"],
      ["example-note", "plugins/first"],
      ["second-note", "plugins/second"],
    ]);
    const folder = await request("plugin/github/preview", {
      url: `${repo}/tree/v1/plugins`,
    });
    expect(folder.status).toBe(200);
    expect(
      (await folder.json()).items.map((item: GithubPluginPreview) => item.id),
    ).toEqual(["example-note", "second-note"]);
    expect((await preview(`${repo}/tree/v1/examples/demo`)).id).toBe(
      "demo-note",
    );
    expect(await readdir(root)).toEqual([]);
    for (const [index, item] of items.entries()) {
      expect(
        (
          await request("plugin/github", {
            token: item.token,
            acceptRisk: true,
          })
        ).status,
      ).toBe(201);
      expect((await readdir(root)).sort()).toEqual(
        items
          .slice(0, index + 1)
          .map((installed) => installed.id)
          .sort(),
      );
      const files = await readdir(path.join(root, item.id));
      expect(files.sort()).toEqual([
        ".covel-install.json",
        "PLUGIN.md",
        "package.json",
        "server",
      ]);
      expect(
        await readFile(path.join(root, item.id, "PLUGIN.md"), "utf8"),
      ).toContain(`name: ${item.id}`);
      const receipt = JSON.parse(
        await readFile(path.join(root, item.id, ".covel-install.json"), "utf8"),
      );
      expect(receipt.source.path).toBe(item.source.path);
    }
  });

  it.each([
    [
      "runtime dependencies",
      {
        ...fixture,
        "package.json": JSON.stringify({
          name: "example-note",
          dependencies: { external: "1.0.0" },
        }),
      },
      400,
    ],
    [
      "builtin identity",
      Object.fromEntries(
        Object.entries(fixture).map(([k, v]) => [
          k,
          v.replaceAll("example-note", "narrator"),
        ]),
      ),
      409,
    ],
    ["forged receipt", { ...fixture, ".covel-install.json": "{}" }, 400],
    ["ambiguous paths", { ...fixture, "SERVER/index.js": "different" }, 400],
  ])("rejects %s", async (_label, files, status) => {
    archive = await zip(files);
    expect((await request("plugin/github/preview", { url: repo })).status).toBe(
      status,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("does not follow redirects or forward credentials", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/private" },
      }),
    );
    expect((await request("plugin/github/preview", { url: repo })).status).toBe(
      502,
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("limits streamed downloads even without Content-Length", async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    expect((await request("plugin/github/preview", { url: repo })).status).toBe(
      413,
    );
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("gates downloads and installed metadata behind operator authentication", async () => {
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-operator");
    expect((await request("plugin/github/preview", { url: repo })).status).toBe(
      401,
    );
    expect((await request("plugins")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (
        await request(
          "plugin/github/preview",
          { url: repo },
          { Authorization: "Bearer synthetic-operator" },
        )
      ).status,
    ).toBe(200);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_INSTALL_API_ENABLED", "1");
    expect((await request("plugin/github/preview", { url: repo })).status).toBe(
      401,
    );
  });
});

it.each([
  "http://github.com/example/plugins",
  "https://github.com.evil.test/example/plugins",
  "https://user:pass@github.com/example/plugins",
  "https://github.com/example/plugins?url=http://127.0.0.1",
  "file:///etc/passwd",
  "https://github.com/example/plugins/releases/latest",
  "https://github.com/example/plugins/tree/main/%2Ftmp",
])("rejects unsupported URL %s", (url) => {
  expect(() => parseGithubUrl(url)).toThrow();
});
it("supports encoded slash refs without guessing where the path starts", () => {
  expect(parseGithubUrl(`${repo}/tree/feature%2Fnotes/plugins/note`)).toEqual({
    owner: "example",
    repo: "plugins",
    ref: "feature/notes",
    directory: "plugins/note",
  });
});
