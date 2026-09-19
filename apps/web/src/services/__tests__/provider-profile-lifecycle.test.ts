import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { registerLlmSettings } from "@/settings/registry/llm.js";
import { setProviderProfiles } from "../api/model-settings.js";

const context = vi.hoisted(() => ({ store: null as unknown as SettingsStore }));
vi.mock("@/settings/store", () => ({
  getSettings: () => context.store,
  registerKnownProviders: vi.fn(),
}));

const profile = {
  id: "fixture",
  name: "Fixture",
  baseUrl: "https://fixture.example/v1",
  models: [{ ref: "model", modelId: "opaque/model" }],
};
let entries: Record<string, unknown>;
let secrets: Record<string, string>;
let adapter: SettingsBackendAdapter;

beforeEach(async () => {
  entries = {
    "llm.providers": [profile],
    "llm.slotConfig": { story: { modelRef: "model" } },
  };
  secrets = { fixture: "synthetic-secret" };
  adapter = {
    load: async () => structuredClone(entries),
    save: vi.fn(async (next) => {
      entries = structuredClone(next);
    }),
    loadSecrets: async () => ({ ...secrets }),
    saveSecrets: vi.fn(async (next) => {
      secrets = { ...next };
    }),
  };
  context.store = new SettingsStore(adapter);
  registerLlmSettings(context.store);
  await context.store.init();
});

describe("provider profile lifecycle", () => {
  it.each(["connection id", "model reference"])(
    "rejects duplicate %s before writing profiles, bindings or credentials",
    async (collision) => {
      const before = structuredClone(entries);
      const conflicting = {
        ...profile,
        id: collision === "connection id" ? profile.id : "other-connection",
        models: [
          {
            ref: collision === "model reference" ? "model" : "another-model",
            modelId: "another/provider-model",
          },
        ],
      };
      await expect(
        setProviderProfiles([profile, conflicting]),
      ).rejects.toThrow();
      expect(adapter.save).not.toHaveBeenCalled();
      expect(adapter.saveSecrets).not.toHaveBeenCalled();
      expect(entries).toEqual(before);
      expect(context.store.get("llm.providers")).toEqual([profile]);
      expect(context.store.get("llm.slotConfig")).toEqual(
        before["llm.slotConfig"],
      );
    },
  );

  it("preserves separate configurations for one provider model when references differ", async () => {
    const profiles = [
      {
        ...profile,
        models: [
          profile.models[0]!,
          { ref: "another-reference", modelId: profile.models[0]!.modelId },
        ],
      },
    ];
    await setProviderProfiles(profiles);
    expect(entries["llm.providers"]).toEqual(profiles);
    expect(entries["llm.slotConfig"]).toEqual({ story: { modelRef: "model" } });
  });

  it("retains the connection and key when its last local model is removed", async () => {
    await setProviderProfiles([{ ...profile, models: [] }]);
    expect(entries["llm.providers"]).toEqual([{ ...profile, models: [] }]);
    expect(entries["llm.slotConfig"]).toEqual({});
    expect(secrets).toEqual({ fixture: "synthetic-secret" });
  });

  it("does not clear credentials or bindings when the profile save fails", async () => {
    const before = structuredClone(entries);
    vi.mocked(adapter.save).mockRejectedValueOnce(
      new Error("synthetic write failure"),
    );
    await expect(setProviderProfiles([])).rejects.toThrow(
      "synthetic write failure",
    );
    expect(entries).toEqual(before);
    expect(secrets).toEqual({ fixture: "synthetic-secret" });
    expect(adapter.saveSecrets).not.toHaveBeenCalled();
  });

  it("never persists a removed model with a dangling role binding", async () => {
    await setProviderProfiles([]);
    const writes = vi.mocked(adapter.save).mock.calls.map(([next]) => next);
    expect(writes).toEqual([{ "llm.providers": [], "llm.slotConfig": {} }]);
  });
});

it("waits for the profile save before cleaning the removed connection key", async () => {
  const gate = deferred<void>();
  vi.mocked(adapter.save).mockImplementationOnce(async (next) => {
    await gate.promise;
    entries = structuredClone(next);
  });
  const pending = setProviderProfiles([]);
  expect(adapter.saveSecrets).not.toHaveBeenCalled();
  expect(secrets.fixture).toBe("synthetic-secret");
  gate.resolve();
  await pending;
  expect(secrets.fixture).toBeUndefined();
});

it.each(["profile", "secret"])(
  "protects a later %s edit from delayed key cleanup",
  async (change) => {
    const gate = deferred<void>();
    vi.mocked(adapter.save).mockImplementationOnce(async (next) => {
      await gate.promise;
      entries = structuredClone(next);
    });
    const removed = setProviderProfiles([]);
    const replacement =
      change === "profile"
        ? setProviderProfiles([profile])
        : context.store.set("keys.fixture", "replacement-secret");
    gate.resolve();
    await Promise.all([removed, replacement]);
    expect(secrets.fixture).toBe(
      change === "profile" ? "synthetic-secret" : "replacement-secret",
    );
  },
);

it("reports key cleanup failure separately after the model configuration commits", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(adapter.saveSecrets).mockRejectedValueOnce(
    new Error("synthetic-secret"),
  );
  const result = await setProviderProfiles([]);
  expect(result.unclearedProviderIds).toEqual(["fixture"]);
  expect(entries).toEqual({ "llm.providers": [], "llm.slotConfig": {} });
  expect(secrets.fixture).toBe("synthetic-secret");
  expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-secret");
  warning.mockRestore();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
