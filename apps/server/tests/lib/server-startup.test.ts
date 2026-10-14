import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createMemoryStore } from "@covel/store/memory";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  store: vi.fn(),
  media: vi.fn(),
  pool: vi.fn(),
  bootstrap: vi.fn(),
  seed: vi.fn(),
  watcher: vi.fn(),
}));
vi.mock("@covel/store/factory", () => ({
  createStoreFromEnv: fakes.store,
  createMediaStoreFromEnv: fakes.media,
  resolveBackendFromEnv: () => "pg",
}));
vi.mock("postgres", () => ({ default: fakes.pool }));
vi.mock("../../src/ai-setup.js", () => ({
  createAiStack: () => ({ gateway: {} }),
}));
vi.mock("../../src/routes/api/bootstrap.js", () => ({
  bootstrapApi: fakes.bootstrap,
}));
vi.mock("../../src/world-seed-reconcile.js", () => ({
  seedAndReconcileWorlds: fakes.seed,
}));
vi.mock("../../src/world-file-watcher.js", () => ({
  createWorldFileWatcher: fakes.watcher,
}));

let home: string;
let startupImport: Promise<unknown> | undefined;
beforeEach(async () => {
  vi.resetModules();
  Object.values(fakes).forEach((mock) => mock.mockReset());
  home = await mkdtemp(join(tmpdir(), "covel-startup-ownership-"));
  vi.stubEnv("COVEL_HOME", home);
  vi.stubEnv("COVEL_USER_WORLDS_DIR", join(home, "user-worlds"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", join(home, "user-plugins"));
  vi.stubEnv("DATABASE_URL", "postgres://fixture.invalid/test");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  // A timed-out import keeps evaluating. Drain it before the next case resets
  // shared mocks, otherwise it can acquire and close the next case's resources.
  if (startupImport) await Promise.allSettled([startupImport]);
  startupImport = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
}, 60_000);

describe("production composition root startup failure", () => {
  it("cleans staging and restores pending world deletion before plugin bootstrap and update application", async () => {
    const worlds = join(home, "user-worlds");
    const abandoned = [
      join(worlds, ".covel-install-crash"),
      join(worlds, ".covel-updates/.covel-install-crash"),
      join(home, "user-plugins/.covel-install-crash"),
      join(home, "user-plugins/.covel-uninstall-crash"),
    ];
    for (const directory of abandoned)
      await mkdir(directory, { recursive: true });
    const stagedWorld = join(worlds, ".covel-world-delete-crash/package");
    await mkdir(stagedWorld, { recursive: true });
    await writeFile(join(stagedWorld, "world.yaml"), "id: interrupted\n");
    const store = createMemoryStore();
    await store.upsertWorld({
      id: "interrupted",
      name: "Interrupted world",
      description: "",
      createdAt: new Date().toISOString(),
      metadata: {
        source: "generated-file",
        storage: { path: worlds },
        worldDeletion: {
          nonce: "old-process",
          startedAt: new Date().toISOString(),
        },
      },
    });
    fakes.store.mockResolvedValue(store);
    fakes.media.mockResolvedValue({ close: async () => {} });
    fakes.pool.mockImplementation(() => ({ end: async () => {} }));
    const stop = new Error("Stop after checking startup recovery");
    fakes.bootstrap.mockImplementation(async () => {
      for (const directory of abandoned)
        await expect(access(directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      await access(join(worlds, "interrupted/world.yaml"));
      expect(await store.getWorld("interrupted")).toMatchObject({
        metadata: { worldDeletion: { retryable: true } },
      });
      throw stop;
    });
    startupImport = import("../../src/app.js");
    await expect(startupImport).rejects.toBe(stop);
    expect(fakes.bootstrap).toHaveBeenCalledOnce();
  }, 60_000);

  it.each([
    "store",
    "media",
    "second-pool",
    "bootstrap",
    "world-seed",
    "second-watcher",
  ] as const)(
    "unwinds acquired resources after failure at %s and preserves its cause",
    async (phase) => {
      const failure = new Error(`failed at ${phase}`);
      const released: string[] = [];
      const close = (name: string) => async () => {
        released.push(name);
      };
      fakes.store.mockImplementation(async () => {
        if (phase === "store") throw failure;
        return { close: close("store") };
      });
      fakes.media.mockImplementation(async () => {
        if (phase === "media") throw failure;
        return { close: close("media") };
      });
      let pools = 0;
      fakes.pool.mockImplementation(() => {
        pools++;
        if (phase === "second-pool" && pools === 2) throw failure;
        return { end: close(pools === 1 ? "locks" : "ingest-locks") };
      });
      fakes.bootstrap.mockImplementation(async () => {
        if (phase === "bootstrap") throw failure;
        return {
          runtimeJobWorker: { close: close("worker") },
          startupMaintenance: Promise.resolve(),
          closePluginEntries: close("entries"),
          closeTools: close("tools"),
          eventBus: { close: close("bus") },
        };
      });
      fakes.seed.mockImplementation(async () => {
        if (phase === "world-seed") throw failure;
      });
      let watchers = 0;
      fakes.watcher.mockImplementation(() => {
        const index = ++watchers;
        return {
          start() {
            if (phase === "second-watcher" && index === 2) throw failure;
          },
          stop: close(`watcher-${index}`),
        };
      });
      startupImport = import("../../src/app.js");
      await expect(startupImport).rejects.toBe(failure);
      const expected = {
        store: [],
        media: ["store"],
        "second-pool": ["media", "store", "locks"],
        bootstrap: ["media", "store", "locks", "ingest-locks"],
        "world-seed": [
          "worker",
          "tools",
          "entries",
          "bus",
          "media",
          "store",
          "locks",
          "ingest-locks",
        ],
        "second-watcher": [
          "watcher-1",
          "watcher-2",
          "worker",
          "tools",
          "entries",
          "bus",
          "media",
          "store",
          "locks",
          "ingest-locks",
        ],
      };
      expect(released).toEqual(expected[phase]);
    },
    // The first case transforms the full production composition root under
    // workspace-wide test load; this suite checks ownership, not startup speed.
    // 15 s was still a speed limit: on a loaded machine the import alone
    // exceeded it. The limit only has to catch a hang.
    60_000,
  );
});
