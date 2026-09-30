import fs, { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfigApiRoutes } from "../../src/routes/config-api.js";
import { getOutboundProxyStatus, outboundFetch } from "@covel/ai-provider";
import { resetOutboundProxyForTests } from "../../../../packages/ai-provider/src/outbound-network.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let home: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(renameSync).mockReset();
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
  await resetOutboundProxyForTests();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = undefined;
});

it("keeps the live proxy dispatcher and disk setting when persistence fails", async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "covel-proxy-atomic-"));
  vi.stubEnv("COVEL_HOME", home);
  vi.stubEnv("COVEL_DESKTOP_REST", "1");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-token");
  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, '[network]\nproxy_mode = "direct"\n', "utf8");
  const app = createConfigApiRoutes({ apiKeys: {} });
  const dispatchers: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      dispatchers.push(init.dispatcher);
      return Promise.resolve(new Response("ok"));
    }),
  );
  const request = () =>
    app.request("/api/config/proxy", {
      method: "PUT",
      headers: {
        Authorization: "Bearer synthetic-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "http", url: "127.0.0.1:58999" }),
    });
  await outboundFetch("https://example.invalid/test");

  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("Synthetic rename failure");
  });
  const failed = await request();
  expect(failed.status).toBe(400);
  expect(getOutboundProxyStatus()).toMatchObject({
    mode: "direct",
    effective: "direct",
  });
  const get = await app.request("/api/config/proxy", {
    headers: { Authorization: "Bearer synthetic-token" },
  });
  expect(await get.json()).toMatchObject({
    mode: "direct",
    effective: "direct",
  });
  expect(fs.readFileSync(configPath, "utf8")).toContain(
    'proxy_mode = "direct"',
  );
  await outboundFetch("https://example.invalid/test");
  expect(dispatchers[1]).toBe(dispatchers[0]);

  const saved = await request();
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    mode: "http",
    effective: "proxy",
  });
  await outboundFetch("https://example.invalid/test");
  expect(dispatchers[2]).not.toBe(dispatchers[0]);
});
