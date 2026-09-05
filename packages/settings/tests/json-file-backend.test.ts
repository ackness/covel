/**
 * The desktop/self-host backend used to swallow every load failure and return
 * `{}`. Because `save()` always writes a full snapshot, that turned a sidecar
 * hiccup during boot into "the next setting change wipes settings.json and
 * keys.env". Only a genuine 404 (nothing written yet) may read as empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJsonFileBackend,
  SERVER_MANAGED_SECRET,
} from "../src/backends/json-file.js";

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  delete (globalThis as { covelIpc?: unknown }).covelIpc;
});

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

describe("json-file backend IPC write contract", () => {
  it("uses the v2 bundle and expected revision over IPC", async () => {
    const invoke = vi
      .fn()
      .mockImplementation((channel: string, payload?: unknown) => {
        if (channel === "covel:settings:load") {
          return Promise.resolve({
            schemaVersion: 2,
            revision: 4,
            savedAt: "old",
            entries: { old: true },
          });
        }
        expect(payload).toEqual({
          entries: { next: true },
          expectedRevision: 4,
        });
        return Promise.resolve({
          ok: true,
          bundle: {
            schemaVersion: 2,
            revision: 5,
            savedAt: "now",
            entries: { next: true },
          },
        });
      });
    (globalThis as { covelIpc?: unknown }).covelIpc = { invoke };
    const backend = createJsonFileBackend();

    await expect(
      backend.saveWithRevision!({ next: true }, 4),
    ).resolves.toMatchObject({
      revision: 5,
      entries: { next: true },
    });
  });

  it("turns an IPC revision conflict into the typed error", async () => {
    (globalThis as { covelIpc?: unknown }).covelIpc = {
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        code: "settings_revision_conflict",
        revision: 3,
      }),
    };
    const backend = createJsonFileBackend();
    await expect(backend.saveWithRevision!({}, 2)).rejects.toMatchObject({
      code: "settings_revision_conflict",
      currentRevision: 3,
    });
  });

  it("rejects when the main process reports a settings write failure", async () => {
    (globalThis as { covelIpc?: unknown }).covelIpc = {
      invoke: vi.fn().mockImplementation((channel: string) =>
        channel === "covel:settings:load"
          ? Promise.resolve({
              schemaVersion: 2,
              revision: 0,
              savedAt: "",
              entries: {},
            })
          : Promise.resolve({ ok: false }),
      ),
    };
    const backend = createJsonFileBackend();

    await expect(backend.save({ "ui.locale": "en-US" })).rejects.toThrow(
      /settings:save.*failed/i,
    );
  });

  it("rejects when the main process reports a secrets write failure", async () => {
    (globalThis as { covelIpc?: unknown }).covelIpc = {
      invoke: vi.fn().mockResolvedValue({ ok: false }),
    };
    const backend = createJsonFileBackend();

    await expect(backend.saveSecrets({ openai: "sk-test" })).rejects.toThrow(
      /keys:save.*failed/i,
    );
  });
});

describe("json-file backend REST secrets contract", () => {
  it("preserves opaque configured providers and translates omissions to deletes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(200, { items: ["deepseek", "open-router"] }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const backend = createJsonFileBackend({ fetchImpl });

    await expect(backend.loadSecrets()).resolves.toEqual({
      deepseek: SERVER_MANAGED_SECRET,
      "open-router": SERVER_MANAGED_SECRET,
    });
    await backend.saveSecrets({
      deepseek: SERVER_MANAGED_SECRET,
      qwen: "new-qwen-key",
    });

    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      qwen: "new-qwen-key",
      "open-router": null,
    });
  });

  it("rejects the old raw-record response instead of silently losing keys", async () => {
    const backend = createJsonFileBackend({
      fetchImpl: vi.fn().mockResolvedValue(res(200, { deepseek: "secret" })),
    });

    await expect(backend.loadSecrets()).rejects.toThrow(/invalid body/);
  });
});
