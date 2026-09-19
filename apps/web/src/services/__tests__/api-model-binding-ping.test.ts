import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let api: typeof import("../api.js");

beforeEach(async () => {
  vi.resetModules();
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  });
  api = await import("../api.js");
  const { initSettings } = await import("@/settings/store.js");
  await initSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit ping bindings", () => {
  it("includes an unbound local model only for its explicit model request", async () => {
    await api.setProviderProfiles(
      [
        {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://fixture.invalid",
          models: [{ ref: "shared-id", modelId: "local-model" }],
        },
      ],
      { story: { presetId: "shared-id" } },
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, latencyMs: 1 }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.pingPreset({ presetId: "shared-id" });
    await api.pingPreset({ modelRef: "shared-id" });
    await api.pingPreset({ slot: "story" });
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        JSON.parse((init as RequestInit).body as string),
      ),
    ).toEqual([
      { presetId: "shared-id" },
      { modelRef: "shared-id" },
      { slot: "story" },
    ]);
    const overlays = fetchMock.mock.calls.map(([, init]) => {
      const encoded = new Headers((init as RequestInit).headers).get(
        "X-Slot-Config",
      )!;
      return JSON.parse(atob(encoded));
    });
    for (const overlay of overlays)
      expect(overlay.slotBindings).toEqual({
        story: { presetId: "shared-id" },
      });
    expect(overlays[0].customPresets).toBeUndefined();
    expect(overlays[1].customPresets).toEqual([
      expect.objectContaining({ id: "shared-id", model: "local-model" }),
    ]);
    expect(overlays[2].customPresets).toBeUndefined();
  });
});
