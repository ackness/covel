import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabaseEnvironment, resetRuntimeCompositionModules } from "./helpers/runtime-composition-storage.js";

const STORAGE_MODULE_ID = "../../../modules/storage/src/index.js";
const COMPOSITION_MODULE_ID = "../src/composition.js";

describe("createRuntimeComposition persisted preset overrides", () => {
  afterEach(() => {
    resetRuntimeCompositionModules();
  });

  it("loads persisted preset metadata and lets it override the runtime preset during composition", async () => {
    resetRuntimeCompositionModules();

    const actualStorage = await vi.importActual<typeof import("../../../modules/storage/src/index.js")>(
      STORAGE_MODULE_ID
    );
    const createPostgresStoragePort = vi.fn(() => ({
      kind: "postgres" as const,
      async createRepositories() {
        const repositories = actualStorage.createInMemoryStorageRepositories() as any;
        repositories.presets = {
          async list() {
            return [
              {
                id: "default-story",
                name: "Persisted default story",
                provider: "openaiCompatible",
                model: "persisted-qwen-max",
                tier: "large",
                baseUrl: "https://persisted.example/v1",
                supportedModes: ["text", "object", "stream"],
                enabled: true,
                isDefault: true,
                scope: "global"
              }
            ];
          }
        };
        return repositories;
      },
      async createArtifactStore() {
        throw new Error("Artifact store access is not part of this test contract.");
      }
    }));

    vi.doMock(STORAGE_MODULE_ID, () => ({
      ...actualStorage,
      createPostgresStoragePort
    }));

    const { createRuntimeComposition } = await import(COMPOSITION_MODULE_ID);
    const composition = await createRuntimeComposition({
      env: createDatabaseEnvironment("postgres://runtime:test@localhost:5432/covel_runtime_preset_override")
    });
    const resolved = composition.profileRegistry.resolveTextTarget({
      presetId: "default-story"
    });

    expect(createPostgresStoragePort).toHaveBeenCalledTimes(1);
    expect(resolved.preset).toMatchObject({
      id: "default-story",
      name: "Persisted default story",
      model: "persisted-qwen-max",
      tier: "large",
      baseUrl: "https://persisted.example/v1"
    });
    expect(resolved.profile).toMatchObject({
      id: "large"
    });
  });
});
