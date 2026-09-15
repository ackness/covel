import fs, { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConfigApiRoutes } from "../../src/routes/config-api.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let home: string;
const original = "DEEPSEEK_API_KEY=synthetic-old\n";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "covel-keys-atomic-"));
  vi.stubEnv("COVEL_HOME", home);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  fs.writeFileSync(path.join(home, "keys.env"), original, "utf8");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(renameSync).mockReset();
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
  fs.rmSync(home, { recursive: true, force: true });
});

it.each([
  { deepseek: "synthetic-new", other: "bad\nvalue" },
  { deepseek: "bad\rvalue" },
  { deepseek: false },
  ["synthetic-new"],
])(
  "rejects invalid key batches without changing either state: %j",
  async (body) => {
    const apiKeys = { deepseek: "synthetic-old", environment: "synthetic-env" };
    const app = createConfigApiRoutes({ apiKeys });
    const response = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(apiKeys).toEqual({
      deepseek: "synthetic-old",
      environment: "synthetic-env",
    });
    expect(fs.readFileSync(path.join(home, "keys.env"), "utf8")).toBe(original);
  },
);

it.each(["synthetic-new", null])(
  "preserves live keys when persisting %s fails",
  async (value) => {
    const apiKeys = { deepseek: "synthetic-old" };
    const app = createConfigApiRoutes({ apiKeys });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("Synthetic rename failure");
    });
    const response = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deepseek: value }),
    });
    expect(response.status).toBe(500);
    expect(apiKeys.deepseek).toBe("synthetic-old");
    expect(fs.readFileSync(path.join(home, "keys.env"), "utf8")).toBe(original);
    expect(fs.readdirSync(home)).toEqual(["keys.env"]);
  },
);
