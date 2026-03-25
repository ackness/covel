import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";

import {
  createInMemoryStorageRepositories,
  createPostgresStoragePort,
  type PostgresStoragePort
} from "../src/index.js";

interface PgQueryResult<Row> {
  rows: Row[];
}

interface PgPoolLike {
  query<Row>(text: string, values?: unknown[]): Promise<PgQueryResult<Row>>;
  end(): Promise<void>;
}

interface ExperimentalPostgresStoragePortOptions {
  pool: PgPoolLike;
  artifactRootDirectory: string;
}

interface PersistedPresetRecord {
  id: string;
  name: string;
  provider: string;
  model: string;
  tier: "small" | "medium" | "large";
  baseUrl: string;
  supportedModes: Array<"text" | "object" | "stream">;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  apiKey: string;
}

interface PersistedPresetMetadata extends Omit<PersistedPresetRecord, "apiKey"> {}

interface PresetRepositoryLike {
  save(input: PersistedPresetRecord): Promise<void>;
  patch(
    presetId: string,
    input: Partial<PersistedPresetRecord>
  ): Promise<PersistedPresetMetadata>;
  getById(id: string): Promise<PersistedPresetMetadata | null>;
  list(): Promise<PersistedPresetMetadata[]>;
}

const createConfiguredPostgresStoragePort = createPostgresStoragePort as unknown as (
  options: ExperimentalPostgresStoragePortOptions
) => PostgresStoragePort;

function createPgMemHarness() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();

  return {
    createPool(): PgPoolLike {
      return new adapter.Pool();
    }
  };
}

function createPresetFixture(): PersistedPresetRecord {
  return {
    id: "default-story",
    name: "Default story",
    provider: "openaiCompatible",
    model: "qwen-plus",
    tier: "medium",
    baseUrl: "https://persisted.example/v1",
    supportedModes: ["text", "object", "stream"],
    enabled: true,
    isDefault: true,
    scope: "global",
    apiKey: "persisted-secret"
  };
}

function expectPresetRepository(repositories: unknown): PresetRepositoryLike {
  const presetRepository = (repositories as { presets?: PresetRepositoryLike }).presets;

  expect(presetRepository).toBeDefined();
  expect(presetRepository?.save).toBeTypeOf("function");
  expect(presetRepository?.patch).toBeTypeOf("function");
  expect(presetRepository?.getById).toBeTypeOf("function");
  expect(presetRepository?.list).toBeTypeOf("function");

  return presetRepository as PresetRepositoryLike;
}

describe("preset metadata persistence", () => {
  const roots: string[] = [];
  const pools: PgPoolLike[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.splice(0, pools.length).map((pool) => pool.end()));
    await Promise.all(
      roots.splice(0, roots.length).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("persists editable preset metadata in memory without returning secret fields", async () => {
    const repositories = createInMemoryStorageRepositories();
    const presets = expectPresetRepository(repositories);
    const preset = createPresetFixture();

    await presets.save(preset);
    await presets.save({
      ...preset,
      name: "Edited story preset",
      model: "qwen-max",
      baseUrl: "https://edited.example/v1",
      apiKey: "rotated-secret"
    });

    await expect(presets.getById(preset.id)).resolves.toEqual({
      id: "default-story",
      name: "Edited story preset",
      provider: "openaiCompatible",
      model: "qwen-max",
      tier: "medium",
      baseUrl: "https://edited.example/v1",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global"
    });
    await expect(presets.list()).resolves.toEqual([
      {
        id: "default-story",
        name: "Edited story preset",
        provider: "openaiCompatible",
        model: "qwen-max",
        tier: "medium",
        baseUrl: "https://edited.example/v1",
        supportedModes: ["text", "object", "stream"],
        enabled: true,
        isDefault: true,
        scope: "global"
      }
    ]);
  });

  it("persists preset metadata across postgres adapter restarts without exposing secrets", async () => {
    const harness = createPgMemHarness();
    const artifactRootDirectory = await mkdtemp(join(tmpdir(), "covel-storage-preset-pg-"));
    const pool = harness.createPool();

    roots.push(artifactRootDirectory);
    pools.push(pool);

    const firstPort = createConfiguredPostgresStoragePort({
      pool,
      artifactRootDirectory
    });
    const firstRepositories = await firstPort.createRepositories();
    const firstPresets = expectPresetRepository(firstRepositories);
    const preset = createPresetFixture();

    await firstPresets.save(preset);

    const secondPort = createConfiguredPostgresStoragePort({
      pool,
      artifactRootDirectory
    });
    const secondRepositories = await secondPort.createRepositories();
    const secondPresets = expectPresetRepository(secondRepositories);

    await expect(secondPresets.getById(preset.id)).resolves.toEqual({
      id: "default-story",
      name: "Default story",
      provider: "openaiCompatible",
      model: "qwen-plus",
      tier: "medium",
      baseUrl: "https://persisted.example/v1",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global"
    });
    await expect(secondPresets.list()).resolves.toEqual([
      {
        id: "default-story",
        name: "Default story",
        provider: "openaiCompatible",
        model: "qwen-plus",
        tier: "medium",
        baseUrl: "https://persisted.example/v1",
        supportedModes: ["text", "object", "stream"],
        enabled: true,
        isDefault: true,
        scope: "global"
      }
    ]);
  });

  it("preserves the stored api key when patching only non-secret postgres preset fields", async () => {
    const harness = createPgMemHarness();
    const artifactRootDirectory = await mkdtemp(join(tmpdir(), "covel-storage-preset-pg-patch-"));
    const pool = harness.createPool();

    roots.push(artifactRootDirectory);
    pools.push(pool);

    const port = createConfiguredPostgresStoragePort({
      pool,
      artifactRootDirectory
    });
    const repositories = await port.createRepositories();
    const presets = expectPresetRepository(repositories);
    const preset = createPresetFixture();

    await presets.save(preset);
    await presets.patch(preset.id, {
      model: "qwen-max",
      enabled: false
    });

    await expect(presets.getById(preset.id)).resolves.toEqual({
      id: "default-story",
      name: "Default story",
      provider: "openaiCompatible",
      model: "qwen-max",
      tier: "medium",
      baseUrl: "https://persisted.example/v1",
      supportedModes: ["text", "object", "stream"],
      enabled: false,
      isDefault: true,
      scope: "global"
    });

    await expect(
      pool.query<{ api_key: string | null }>(
        "select api_key from preset_metadata where id = $1",
        [preset.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          api_key: "persisted-secret"
        }
      ]
    });
  });
});
