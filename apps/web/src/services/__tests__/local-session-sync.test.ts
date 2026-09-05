import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { ApiError } from "../api/request.js";

const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  createWorld: vi.fn(),
  updateWorld: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  uploadBrowserCheckpoint: vi.fn(),
  fetchBrowserCommit: vi.fn(),
}));

const appKv = vi.hoisted(() => ({
  getStatePatches: vi.fn(async () => null),
  saveStatePatches: vi.fn(async () => {}),
  removeStatePatches: vi.fn(async () => {}),
  getSubmittedBlocks: vi.fn(async () => null),
  saveSubmittedBlocks: vi.fn(async () => {}),
  removeSubmittedBlocks: vi.fn(async () => {}),
  saveExecutionSteps: vi.fn(async () => {}),
  getExecutionSteps: vi.fn(async () => []),
}));

vi.mock("../api.js", () => api);
vi.mock("../app-kv-store.js", () => appKv);

const { LocalDataService } = await import("../data-service/local.js");

let vault: BrowserVault;
let sequence = 0;

async function serviceWithWorld(
  worldId = "world-1",
  metadata?: Record<string, unknown>,
): Promise<InstanceType<typeof LocalDataService>> {
  vault = new BrowserVault({ dbName: `local-session-sync-${++sequence}` });
  await vault.upsertWorld({
    id: worldId,
    name: "World",
    description: "",
    metadata,
    createdAt: new Date().toISOString(),
  });
  return new LocalDataService(vault);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWorld.mockResolvedValue({ id: "world-1" });
  api.updateWorld.mockResolvedValue({ id: "world-1" });
  api.getSession.mockRejectedValue(
    new ApiError(404, "/api/sessions/sess-1", ""),
  );
  api.createSession.mockResolvedValue({
    id: "sess-1",
    // A server-created session without setup runtimes starts directly in the
    // main loop. Keep this deliberately different from LocalDataService's
    // fresh local checkpoint so the first-hydrate merge is observable.
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
  });
  api.deleteSession.mockResolvedValue(undefined);
  api.uploadBrowserCheckpoint.mockResolvedValue({ ok: true, revision: 1 });
});

afterEach(async () => {
  await vault?.deleteDatabase();
});

describe("LocalDataService browser-authoritative sync", () => {
  it("prepares the complete local world before server-side planning", async () => {
    const service = await serviceWithWorld("world-local", {
      pluginPolicy: { requiredPluginIds: ["world-notes"] },
      source: "browser-indexeddb",
    });
    await service.updateWorld("world-local", {
      lore: "Local lore",
      locale: "en-US",
      tags: ["mystery"],
      dimensions: { custom: { enabled: true } },
    });
    api.getWorld.mockRejectedValueOnce(
      new ApiError(404, "/api/worlds/world-local", ""),
    );

    await service.prepareWorldForServer("world-local");

    expect(api.createWorld).toHaveBeenCalledWith({
      id: "world-local",
      name: "World",
      description: "",
      lore: "Local lore",
      tags: ["mystery"],
      locale: "en-US",
      dimensions: { custom: { enabled: true } },
      metadata: {
        pluginPolicy: { requiredPluginIds: ["world-notes"] },
        source: "browser-indexeddb",
      },
      createdAt: expect.any(String),
    });
  });

  it("refreshes an existing transient world mirror", async () => {
    const service = await serviceWithWorld("world-1", {
      pluginPolicy: { excludedPluginIds: ["economy"] },
    });

    await service.prepareWorldForServer("world-1");

    expect(api.updateWorld).toHaveBeenCalledWith(
      "world-1",
      expect.objectContaining({
        name: "World",
        metadata: {
          pluginPolicy: { excludedPluginIds: ["economy"] },
        },
      }),
      { silentStatuses: [401] },
    );
  });

  it("uses an existing shared world for planning when operator access is required", async () => {
    const service = await serviceWithWorld();
    api.updateWorld.mockRejectedValueOnce(
      new ApiError(
        401,
        "/api/worlds/world-1",
        JSON.stringify({
          error: "Operator required",
          code: "operator_token_required",
        }),
      ),
    );

    await expect(
      service.prepareWorldForServer("world-1"),
    ).resolves.toBeUndefined();

    expect(api.createWorld).not.toHaveBeenCalled();
    expect(api.uploadBrowserCheckpoint).not.toHaveBeenCalled();
  });

  it.each(["existing", "recreated"])(
    "hydrates a %s session without operator permission to update its shared world",
    async (mirror) => {
      const service = await serviceWithWorld();
      await service.createSession("world-1", undefined, "sess-1", [], "en-US");
      await service.addMessage({
        id: "durable-message",
        sessionId: "sess-1",
        role: "user",
        content: "Preserved browser history",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      if (mirror === "existing")
        api.getSession.mockResolvedValueOnce({ id: "sess-1" });
      api.updateWorld.mockRejectedValueOnce(
        new ApiError(
          401,
          "/api/worlds/world-1",
          JSON.stringify({
            error: "Operator required",
            code: "operator_token_required",
          }),
        ),
      );

      await service.syncToServer("sess-1");

      expect(api.createWorld).not.toHaveBeenCalled();
      expect(api.createSession).toHaveBeenCalledTimes(
        mirror === "existing" ? 0 : 1,
      );
      expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({
          messages: [expect.objectContaining({ id: "durable-message" })],
        }),
      );
    },
  );

  it.each([
    ["GET", 401, "operator_token_required"],
    ["GET", 500, "internal"],
    ["PATCH", 500, "internal"],
    ["PATCH", 401, "session_owner_required"],
    ["PATCH", 401, undefined],
    ["PATCH", 403, "operator_token_required"],
  ] as const)(
    "propagates %s %i (%s) before session hydration",
    async (method, status, code) => {
      const service = await serviceWithWorld();
      await service.createSession("world-1", undefined, "sess-1", [], "en-US");
      const error = new ApiError(
        status,
        "/api/worlds/world-1",
        JSON.stringify({
          error: "World sync failed",
          ...(code ? { code } : {}),
        }),
      );
      (method === "GET" ? api.getWorld : api.updateWorld).mockRejectedValueOnce(
        error,
      );

      await expect(service.syncToServer("sess-1")).rejects.toBe(error);

      expect(api.createWorld).not.toHaveBeenCalled();
      expect(api.getSession).not.toHaveBeenCalled();
      expect(api.uploadBrowserCheckpoint).not.toHaveBeenCalled();
    },
  );

  it("refuses to hydrate a missing world when its creation requires an operator", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    api.getWorld.mockRejectedValueOnce(
      new ApiError(404, "/api/worlds/world-1", ""),
    );
    const denied = new ApiError(
      401,
      "/api/worlds",
      JSON.stringify({
        error: "Operator required",
        code: "operator_token_required",
      }),
    );
    api.createWorld.mockRejectedValueOnce(denied);

    await expect(service.syncToServer("sess-1")).rejects.toBe(denied);

    expect(api.updateWorld).not.toHaveBeenCalled();
    expect(api.uploadBrowserCheckpoint).not.toHaveBeenCalled();
  });

  it("persists the selected plugin set, locale, and requested id", async () => {
    const service = await serviceWithWorld();
    const session = await service.createSession(
      "world-1",
      "preset-1",
      "session-explicit",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );

    expect(session).toMatchObject({
      id: "session-explicit",
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
    await expect(service.getSession(session.id)).resolves.toMatchObject({
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
  });

  it("seeds portable generated characters and lorebook into a local checkpoint", async () => {
    const service = await serviceWithWorld("portable-world", {
      characterBlueprints: [
        {
          schemaVersion: 1,
          id: "thread-keeper",
          name: "Thread Keeper",
          role: "npc",
          description: "Keeps promises visible.",
          instantiate: {
            characterId: "npc-thread-keeper",
            name: "Keeper of Threads",
            type: "companion",
            description: "Makes every promise visible.",
            fields: { faction: "Silver House", trust: 20 },
          },
        },
        {
          id: "missing-schema-version",
          name: "Invalid Blueprint",
        },
      ],
      embeddedLorebook: [
        {
          id: "silver-threads",
          content: "Every promise creates a visible silver thread.",
          strategy: "constant",
          position: "before_plugin",
        },
      ],
    });

    await service.createSession(
      "portable-world",
      undefined,
      "sess-portable",
      [],
      "en-US",
    );

    await expect(
      vault.getLatestCheckpoint("sess-portable"),
    ).resolves.toMatchObject({
      characters: [
        {
          id: "sess-portable-npc-thread-keeper",
          name: "Keeper of Threads",
          type: "companion",
          description: "Makes every promise visible.",
          fields: { faction: "Silver House", trust: 20 },
        },
      ],
      lorebookEntries: [
        {
          id: "silver-threads",
          strategy: "constant",
          position: "before_plugin",
        },
      ],
    });
  });

  it("creates and hydrates the transient server mirror", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", "preset-1", "sess-1", [], "en-US");

    await service.syncToServer("sess-1");

    expect(api.createSession).toHaveBeenCalledWith(
      "world-1",
      "preset-1",
      "sess-1",
      [],
      "en-US",
    );
    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledOnce();
    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        sessionId: "sess-1",
        profile: "browser-private",
        revision: 2,
        session: expect.objectContaining({
          phase: "playing",
          completedPlayerTurns: 0,
          setupRuntimes: {},
        }),
      }),
    );
    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toMatchObject({
      revision: 2,
      session: {
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
      },
    });
  });

  it("uploads a locale-resolved server world without downgrading browser i18n", async () => {
    const service = await serviceWithWorld("localized-world");
    await vault.upsertWorld({
      id: "localized-world",
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
      description: { "zh-CN": "雾中港口", "en-US": "A port in fog" },
      locale: "zh-CN",
      createdAt: "2026-08-25T00:00:00.000Z",
    } as never);
    await service.createSession(
      "localized-world",
      undefined,
      "sess-localized",
      [],
      "zh-CN",
    );

    await service.syncToServer("sess-localized");

    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "sess-localized",
      expect.objectContaining({
        world: expect.objectContaining({
          name: "雾港",
          description: "雾中港口",
        }),
      }),
    );
    await expect(vault.getWorld("localized-world")).resolves.toMatchObject({
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
    });
  });

  it("preserves an established browser clock when rebuilding a missing mirror", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    const current = await vault.getLatestCheckpoint("sess-1");
    if (!current) throw new Error("missing checkpoint");
    await vault.applySessionCommit({
      baseRevision: current.revision,
      revision: current.revision + 1,
      actionId: "turn:established",
      checkpoint: {
        ...current,
        session: {
          ...current.session,
          phase: "playing",
          completedPlayerTurns: 4,
          setupRuntimes: {},
        },
        revision: current.revision + 1,
        actionId: "turn:established",
        committedAt: "2026-08-26T00:00:00.000Z",
      },
    });

    await service.syncToServer("sess-1");

    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        revision: 2,
        session: expect.objectContaining({
          phase: "playing",
          completedPlayerTurns: 4,
        }),
      }),
    );
  });

  it("preserves stable message identity in retry-safe checkpoint uploads", async () => {
    const service = await serviceWithWorld();
    const now = "2026-01-01T00:00:00.000Z";
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    await service.addMessage({
      id: "local-message-1",
      sessionId: "sess-1",
      role: "user",
      content: "hello",
      createdAt: now,
    });

    await service.syncToServer("sess-1");

    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            id: "local-message-1",
            content: "hello",
            createdAt: now,
          }),
        ],
      }),
    );
  });

  it("preserves underscore ids across the checkpoint boundary", async () => {
    const service = await serviceWithWorld("world_underscore");
    await service.createSession(
      "world_underscore",
      undefined,
      "session_underscore",
      [],
      "en-US",
    );

    await service.syncToServer("session_underscore");

    expect(api.getWorld).toHaveBeenCalledWith("world_underscore", {
      silentErrors: true,
    });
    expect(api.getSession).toHaveBeenCalledWith("session_underscore", {
      silentErrors: true,
    });
    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "session_underscore",
      expect.objectContaining({ sessionId: "session_underscore" }),
    );
  });

  it("does not turn a real sync error into a create probe", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    const error = new Error("server unavailable");
    api.getWorld.mockRejectedValue(error);

    await expect(service.syncToServer("sess-1")).rejects.toBe(error);
    expect(api.createWorld).not.toHaveBeenCalled();
  });

  it("deletes both the local authority and transient mirror", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");

    await service.deleteSession("sess-1");

    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toBeNull();
    expect(api.deleteSession).toHaveBeenCalledWith("sess-1");
  });

  it("serializes concurrent server commits against the latest browser revision", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    api.fetchBrowserCommit.mockImplementation(
      async (_sessionId: string, actionId: string, baseRevision: number) => {
        const current = await vault.getLatestCheckpoint("sess-1");
        if (!current) throw new Error("missing checkpoint");
        return {
          baseRevision,
          revision: baseRevision + 1,
          actionId,
          checkpoint: {
            ...current,
            revision: baseRevision + 1,
            actionId,
            committedAt: new Date().toISOString(),
          },
        };
      },
    );

    await Promise.all([
      service.commitFromServer("sess-1", "background-a"),
      service.commitFromServer("sess-1", "turn-b"),
    ]);

    expect(api.fetchBrowserCommit.mock.calls.map((call) => call[2])).toEqual([
      1, 2,
    ]);
    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toMatchObject({
      revision: 3,
      actionId: "turn-b",
    });
  });

  it("keeps the browser world document when applying a server commit", async () => {
    const service = await serviceWithWorld("localized-world");
    await vault.upsertWorld({
      id: "localized-world",
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
      description: { "zh-CN": "雾中港口", "en-US": "A port in fog" },
      createdAt: "2026-08-25T00:00:00.000Z",
    } as never);
    await service.createSession(
      "localized-world",
      undefined,
      "sess-localized",
      [],
      "zh-CN",
    );
    api.fetchBrowserCommit.mockImplementation(
      async (_sessionId: string, actionId: string, baseRevision: number) => {
        const current = await vault.getLatestCheckpoint("sess-localized");
        if (!current) throw new Error("missing checkpoint");
        return {
          baseRevision,
          revision: baseRevision + 1,
          actionId,
          checkpoint: {
            ...current,
            world: {
              id: "localized-world",
              name: "雾港",
              description: "雾中港口",
              createdAt: "2026-08-25T00:00:00.000Z",
            },
            revision: baseRevision + 1,
            actionId,
            committedAt: "2026-08-26T00:00:00.000Z",
          },
        };
      },
    );

    await service.commitFromServer("sess-localized", "turn-1");

    await expect(vault.getWorld("localized-world")).resolves.toMatchObject({
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
    });
    await expect(
      vault.getLatestCheckpoint("sess-localized"),
    ).resolves.toMatchObject({
      world: {
        name: { "zh-CN": "雾港", "en-US": "Mistport" },
      },
    });
  });

  it("recovers a durably staged commit after the data service is recreated", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    await service.syncToServer("sess-1");
    await service.stageServerCommit("sess-1", "turn-pending");

    const downloadError = new Error("connection reset");
    api.fetchBrowserCommit.mockRejectedValueOnce(downloadError);
    await expect(
      service.commitFromServer("sess-1", "turn-pending"),
    ).rejects.toBe(downloadError);

    api.getWorld.mockResolvedValue({ id: "world-1" });
    api.getSession.mockResolvedValue({ id: "sess-1" });
    api.fetchBrowserCommit.mockImplementation(
      async (_sessionId: string, actionId: string, baseRevision: number) => {
        const current = await vault.getLatestCheckpoint("sess-1");
        if (!current) throw new Error("missing checkpoint");
        return {
          baseRevision,
          revision: baseRevision + 1,
          actionId,
          checkpoint: {
            ...current,
            revision: baseRevision + 1,
            actionId,
            committedAt: "2026-08-26T00:00:00.000Z",
          },
        };
      },
    );

    const reloadedService = new LocalDataService(vault);
    await reloadedService.syncToServer("sess-1");

    expect(api.fetchBrowserCommit).toHaveBeenCalledTimes(2);
    expect(api.uploadBrowserCheckpoint).toHaveBeenLastCalledWith(
      "sess-1",
      expect.objectContaining({
        revision: 3,
        actionId: "turn-pending",
      }),
    );
    await expect(vault.getPendingCommit("sess-1")).resolves.toBeNull();
  });

  it("serializes a browser message before a concurrent server checkpoint", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    api.fetchBrowserCommit.mockImplementation(
      async (_sessionId: string, actionId: string, baseRevision: number) => {
        const current = await vault.getLatestCheckpoint("sess-1");
        if (!current) throw new Error("missing checkpoint");
        return {
          baseRevision,
          revision: baseRevision + 1,
          actionId,
          checkpoint: {
            ...current,
            revision: baseRevision + 1,
            actionId,
            committedAt: new Date().toISOString(),
          },
        };
      },
    );

    await Promise.all([
      service.addMessage({
        id: "message-1",
        sessionId: "sess-1",
        role: "user",
        content: "hello",
        createdAt: "2026-08-26T00:00:00.000Z",
      }),
      service.commitFromServer("sess-1", "background-1"),
    ]);

    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toMatchObject({
      revision: 3,
      actionId: "background-1",
      messages: [expect.objectContaining({ id: "message-1" })],
    });
  });
});
