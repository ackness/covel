import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeServer } from "../src/index.js";

interface PersistedPresetRecord {
  id: string;
  name: string;
  provider: string;
  model: string;
  tier: "small" | "medium" | "large";
  baseUrl: string;
  fallbackPresetIds?: string[];
  supportedModes: Array<"text" | "object" | "stream">;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  apiKey?: string;
}

type PublicPresetMetadata = Omit<PersistedPresetRecord, "apiKey">;

async function listen(server: ReturnType<typeof createRuntimeServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve listening address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("runtime presets API", () => {
  const servers = new Set<ReturnType<typeof createRuntimeServer>>();

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      Array.from(servers).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
    servers.clear();
  });

  it("serves GET /presets from persisted metadata and never returns secrets", async () => {
    const persistedPreset: PersistedPresetRecord = {
      id: "default-story",
      name: "Persisted story",
      provider: "openaiCompatible",
      model: "qwen-plus",
      tier: "medium",
      baseUrl: "https://persisted.example/v1",
      fallbackPresetIds: ["fallback-lab"],
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global",
      apiKey: "top-secret"
    };
    const list = vi.fn<() => Promise<PublicPresetMetadata[]>>().mockResolvedValue([
      {
        id: "default-story",
        name: "Persisted story",
        provider: "openaiCompatible",
        model: "qwen-plus",
        tier: "medium",
        baseUrl: "https://persisted.example/v1",
        fallbackPresetIds: ["fallback-lab"],
        supportedModes: ["text", "object", "stream"],
        enabled: true,
        isDefault: true,
        scope: "global"
      }
    ]);
    const patch = vi.fn();

    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      presetMetadataStore: {
        list,
        patch
      }
    } as any);
    servers.add(server);

    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/presets`);
    const body = await response.json() as PublicPresetMetadata[];

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    expect(body).toEqual([
      {
        id: "default-story",
        name: "Persisted story",
        provider: "openaiCompatible",
        model: "qwen-plus",
        tier: "medium",
        baseUrl: "https://persisted.example/v1",
        fallbackPresetIds: ["fallback-lab"],
        supportedModes: ["text", "object", "stream"],
        enabled: true,
        isDefault: true,
        scope: "global"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain(persistedPreset.apiKey as string);
    expect(patch).not.toHaveBeenCalled();
  });

  it("patches only editable preset metadata and excludes routing + secret fields from PATCH /presets/:id responses", async () => {
    const patch = vi.fn<
      (presetId: string, input: Partial<PersistedPresetRecord>) => Promise<PublicPresetMetadata>
    >().mockImplementation(async (presetId, input) => ({
      id: presetId,
      name: String(input.name),
      provider: "openaiCompatible",
      model: String(input.model),
      tier: "medium",
      baseUrl: "https://persisted.example/v1",
      fallbackPresetIds: Array.isArray(input.fallbackPresetIds) ? input.fallbackPresetIds : undefined,
      supportedModes: ["text", "object", "stream"],
      enabled: Boolean(input.enabled),
      isDefault: true,
      scope: "global"
    }));

    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      presetMetadataStore: {
        async list() {
          return [];
        },
        patch
      }
    } as any);
    servers.add(server);

    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/presets/default-story`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Edited preset",
        model: "qwen-max",
        baseUrl: "https://edited.example/v1",
        enabled: false,
        isDefault: true,
        fallbackPresetIds: ["fallback-lab", "openrouter-free"],
        apiKey: "should-store-but-never-return"
      })
    });
    const body = await response.json() as PublicPresetMetadata & { apiKey?: string };

    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("default-story", {
      name: "Edited preset",
      model: "qwen-max",
      enabled: false,
      isDefault: true,
      fallbackPresetIds: ["fallback-lab", "openrouter-free"]
    });
    expect(body).toEqual({
      id: "default-story",
      name: "Edited preset",
      provider: "openaiCompatible",
      model: "qwen-max",
      tier: "medium",
      baseUrl: "https://persisted.example/v1",
      fallbackPresetIds: ["fallback-lab", "openrouter-free"],
      supportedModes: ["text", "object", "stream"],
      enabled: false,
      isDefault: true,
      scope: "global"
    });
    expect(body.apiKey).toBeUndefined();
  });
});
