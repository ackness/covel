import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonFileBackend } from "../src/backends/json-file.js";

afterEach(() => {
  delete (globalThis as { covelIpc?: unknown }).covelIpc;
});

describe("json-file backend load contract", () => {
  it("requires an explicit IPC transport", () => {
    // @ts-expect-error The JSON file backend requires a host-owned bridge.
    expect(() => createJsonFileBackend({})).toThrow(
      /requires an IPC transport/,
    );
  });
  it("uses the supplied transport instead of another host's ambient bridge", async () => {
    const ambientInvoke = vi.fn();
    (globalThis as { covelIpc?: unknown }).covelIpc = { invoke: ambientInvoke };
    const invoke = vi.fn().mockResolvedValue({
      schemaVersion: 2,
      revision: 0,
      savedAt: "",
      entries: { "ui.locale": "en-US" },
    });
    const backend = createJsonFileBackend({ ipc: { invoke } });

    await expect(backend.load()).resolves.toEqual({ "ui.locale": "en-US" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("covel:settings:load");
    expect(ambientInvoke).not.toHaveBeenCalled();
  });

  it("propagates IPC read failures instead of reporting an empty store", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("read failed"));
    const backend = createJsonFileBackend({ ipc: { invoke } });

    await expect(backend.load()).rejects.toThrow("read failed");
    await expect(backend.loadSecrets()).rejects.toThrow("read failed");
  });

  it("loads secret values through IPC", async () => {
    const invoke = vi.fn().mockResolvedValue({ fixture: "synthetic-secret" });
    const backend = createJsonFileBackend({ ipc: { invoke } });

    await expect(backend.loadSecrets()).resolves.toEqual({
      fixture: "synthetic-secret",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("covel:keys:load");
  });

  it("asks only the desktop shell where an earlier settings file went", async () => {
    const invoke = vi.fn().mockResolvedValue("settings.v1.bak.json");
    await expect(
      createJsonFileBackend({ ipc: { invoke } }).takeArchivedBundle!(),
    ).resolves.toBe("settings.v1.bak.json");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("covel:settings:archived");
  });

  it("rejects an unversioned IPC response before saving", async () => {
    const invoke = vi.fn().mockResolvedValue({ entries: { retained: true } });
    const backend = createJsonFileBackend({ ipc: { invoke } });

    await expect(backend.load()).rejects.toThrow(/unsupported/);
    await expect(backend.save({ replacement: true })).rejects.toThrow(
      /unsupported/,
    );
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "covel:settings:load",
      "covel:settings:load",
    ]);
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
    const backend = createJsonFileBackend({ ipc: { invoke } });

    await expect(
      backend.saveWithRevision!({ next: true }, 4),
    ).resolves.toMatchObject({
      revision: 5,
      entries: { next: true },
    });
  });

  it("turns an IPC revision conflict into the typed error", async () => {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        code: "settings_revision_conflict",
        revision: 3,
      }),
    };
    const backend = createJsonFileBackend({ ipc });
    await expect(backend.saveWithRevision!({}, 2)).rejects.toMatchObject({
      code: "settings_revision_conflict",
      currentRevision: 3,
    });
  });

  it("rejects when the main process reports a settings write failure", async () => {
    const ipc = {
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
    const backend = createJsonFileBackend({ ipc });

    await expect(backend.save({ "ui.locale": "en-US" })).rejects.toThrow(
      /settings:save.*failed/i,
    );
  });

  it("rejects when the main process reports a secrets write failure", async () => {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({ ok: false }),
    };
    const backend = createJsonFileBackend({ ipc });

    await expect(backend.saveSecrets({ openai: "sk-test" })).rejects.toThrow(
      /keys:save.*failed/i,
    );
  });
});

describe("json-file backend IPC secrets contract", () => {
  it("passes explicit secret patches unchanged through IPC", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const backend = createJsonFileBackend({ ipc: { invoke } });
    await backend.saveSecrets({ providerA: "synthetic-a", providerB: null });
    expect(invoke).toHaveBeenCalledWith("covel:keys:save", {
      providerA: "synthetic-a",
      providerB: null,
    });
  });
});
