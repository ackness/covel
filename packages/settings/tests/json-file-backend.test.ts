/**
 * The desktop/self-host backend used to swallow every load failure and return
 * `{}`. Because `save()` always writes a full snapshot, that turned a sidecar
 * hiccup during boot into "the next setting change wipes settings.json and
 * keys.env". Only a genuine 404 (nothing written yet) may read as empty.
 */
import { describe, expect, it, vi } from "vitest";
import { createJsonFileBackend } from "../src/backends/json-file.js";

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("json-file backend load contract", () => {
  it("treats 404 as an empty store", async () => {
    const backend = createJsonFileBackend({
      fetchImpl: vi.fn().mockResolvedValue(res(404, {})),
    });
    await expect(backend.load()).resolves.toEqual({});
    await expect(backend.loadSecrets()).resolves.toEqual({});
  });

  it("propagates a server error instead of reporting an empty store", async () => {
    const backend = createJsonFileBackend({
      fetchImpl: vi.fn().mockResolvedValue(res(500, {})),
    });
    await expect(backend.load()).rejects.toThrow(/HTTP 500/);
    await expect(backend.loadSecrets()).rejects.toThrow(/HTTP 500/);
  });

  it("propagates a transport failure", async () => {
    const backend = createJsonFileBackend({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });
    await expect(backend.load()).rejects.toThrow(/Failed to fetch/);
  });

  it("returns stored entries on success", async () => {
    const backend = createJsonFileBackend({
      fetchImpl: vi
        .fn()
        .mockResolvedValue(res(200, { entries: { "ui.locale": "en-US" } })),
    });
    await expect(backend.load()).resolves.toEqual({ "ui.locale": "en-US" });
  });
});
