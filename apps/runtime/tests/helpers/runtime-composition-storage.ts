import { vi } from "vitest";

const STORAGE_MODULE_ID = "../../../../modules/storage/src/index.js";
const COMPOSITION_MODULE_ID = "../../src/composition.js";

const PROVIDER_ENV_KEYS = [
  "LIVE_LLM_PROVIDER",
  "LIVE_LLM_PRIMARY_BASE_URL",
  "LIVE_LLM_PRIMARY_API_KEY",
  "LIVE_LLM_PRIMARY_MODEL",
  "LIVE_LLM_SECONDARY_MODEL",
  "LIVE_LLM_EMBED_MODEL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_MODEL",
  "DASHSCOPE_BASE_URL",
  "DASHSCOPE_API_KEY"
] as const;

export function createDatabaseEnvironment(databaseUrl = "postgres://runtime:test@localhost:5432/covel_runtime_test") {
  return {
    ...clearProviderEnvironment(),
    DATABASE_URL: databaseUrl
  };
}

export function clearProviderEnvironment(): Record<string, undefined> {
  return Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, undefined])) as Record<string, undefined>;
}

export async function importRuntimeComposition() {
  resetRuntimeCompositionModules();
  return import(COMPOSITION_MODULE_ID);
}

export async function importRuntimeCompositionWithStorageSpies() {
  resetRuntimeCompositionModules();

  const actual = await vi.importActual<typeof import("../../../../modules/storage/src/index.js")>(
    STORAGE_MODULE_ID
  );
  const inMemoryFactory = vi.fn(actual.createInMemoryStorageRepositories);
  const createPostgresStoragePort = vi.fn(() => ({
    kind: "postgres" as const,
    async createRepositories() {
      return actual.createInMemoryStorageRepositories();
    },
    async createArtifactStore() {
      throw new Error("Artifact store access is not part of this test contract.");
    }
  }));

  vi.doMock(STORAGE_MODULE_ID, () => ({
    ...actual,
    createInMemoryStorageRepositories: inMemoryFactory,
    createPostgresStoragePort
  }));

  const composition = await import(COMPOSITION_MODULE_ID);

  return {
    ...composition,
    inMemoryFactory,
    createPostgresStoragePort
  };
}

export function resetRuntimeCompositionModules() {
  vi.doUnmock(STORAGE_MODULE_ID);
  vi.resetModules();
}
