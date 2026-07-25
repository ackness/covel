/**
 * Tests for session plugin enable/disable routes.
 *
 * Mounts the REAL sessionRoutes from src/routes/api/session.ts so we test
 * production code, not a hand-copied shadow. (Fix for 2026-04-12 audit
 * Finding 5: the previous version of this file declared its own Hono routes
 * inline that drifted from the real implementation.)
 *
 * Covers:
 * - H1: core-plugin cannot be disabled (enforced by manifest.pluginType,
 *       not hardcoded plugin IDs — see CLAUDE.md framework-plugin isolation)
 * - H3: pluginId body validation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  createRpcApprovalGate,
  type RpcApprovalGate,
} from "@covel/approval";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginSummary,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import { sessionRoutes } from "../../src/routes/api/session.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<PluginSummary>): PluginSummary {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    description: "A test plugin",
    pluginType: "plugin",
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(
  overrides?: Partial<PluginRegistryEntry>,
): PluginRegistryEntry {
  return {
    id: "test-plugin",
    summary: makeSummary(),
    loadedRuntimes: new Map(),
    status: "registered",
    ...overrides,
  };
}

/**
 * Mount the real sessionRoutes module under /api/sessions, mirroring how
 * bootstrap.ts wires it. Tests then exercise production behavior 1:1.
 */
function createTestApp(
  registry: PluginRegistry,
  store: DataStore,
  rpcApprovalGate: RpcApprovalGate,
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe("Session plugin routes (real sessionRoutes)", () => {
  let registry: PluginRegistry;
  let store: DataStore;
  let app: Hono;
  let rpcApprovalGate: RpcApprovalGate;
  const SESSION_ID = "sess-1";

  beforeEach(async () => {
    registry = createPluginRegistry();
    store = createMemoryStore();
    rpcApprovalGate = createRpcApprovalGate();
    app = createTestApp(registry, store, rpcApprovalGate);

    // Register plugins. `source: 'builtin'` mirrors how bootstrap.ts marks
    // shipped plugins by load path; trust is no longer inferred from any name
    // prefix, so the test must set it explicitly.
    registry.register(
      makeEntry({
        id: "narrator",
        summary: makeSummary({
          id: "narrator",
          name: "Core Narrator",
          pluginType: "core-plugin",
          relations: {
            provides: ["narrative-engine"],
            conflicts: ["chat-mode-narrator"],
          },
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "pregame",
        summary: makeSummary({
          id: "pregame",
          name: "Core Pre-Game",
          pluginType: "core-plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "optional-plugin",
        summary: makeSummary({
          id: "optional-plugin",
          name: "Optional Plugin",
          pluginType: "plugin",
        }),
        source: "community",
      }),
    );
    registry.register(
      makeEntry({
        id: "chat-mode-narrator",
        summary: makeSummary({
          id: "chat-mode-narrator",
          name: "Chat Mode Narrator",
          pluginType: "plugin",
          relations: {
            provides: ["narrative-engine"],
            requires: [
              "scene-cast",
              "scene-prompts",
              "character-blueprint",
              "character-presence",
              "player-identity",
              "living-world-rules",
              "branch-reply",
            ],
            conflicts: ["narrator"],
          },
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "scene-cast",
        summary: makeSummary({
          id: "scene-cast",
          name: "Scene Cast",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "scene-prompts",
        summary: makeSummary({
          id: "scene-prompts",
          name: "Scene Prompts",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "character-blueprint",
        summary: makeSummary({
          id: "character-blueprint",
          name: "Character Blueprint",
          pluginType: "plugin",
        }),
        // Declares it accepts world blueprints + mirrored characters — drives
        // capability discovery (blueprintStorageTargets / characterMirrorTargets)
        // instead of the framework hardcoding the plugin id.
        dataSchemas: {
          blueprints: {
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/blueprints.schema.json",
          },
          characters: {
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/characters.schema.json",
          },
        },
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "character-presence",
        summary: makeSummary({
          id: "character-presence",
          name: "Character Presence",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "player-identity",
        summary: makeSummary({
          id: "player-identity",
          name: "Player Identity",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "living-world-rules",
        summary: makeSummary({
          id: "living-world-rules",
          name: "Living World Rules",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );
    registry.register(
      makeEntry({
        id: "branch-reply",
        summary: makeSummary({
          id: "branch-reply",
          name: "Branch Reply",
          pluginType: "plugin",
        }),
        source: "builtin",
      }),
    );

    // Create a session with both plugins active
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ["narrator", "optional-plugin"],
      createdAt: new Date().toISOString(),
    });
  });

  describe("H1: core-plugin cannot be disabled", () => {
    it("includes required core plugins when creating a session from a partial plugin list", async () => {
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-core-create",
          plugins: ["optional-plugin"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toEqual(
        expect.arrayContaining(["narrator", "pregame"]),
      );
      expect(body.activePlugins).not.toContain("optional-plugin");

      const session = await store.getSession("sess-core-create");
      expect(session?.activePlugins).toEqual(
        expect.arrayContaining(["narrator", "pregame"]),
      );
      expect(session?.activePlugins).not.toContain("optional-plugin");
    });

    it("uses chat-mode-narrator instead of the default narrator when requested", async () => {
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-chat-create",
          plugins: ["chat-mode-narrator", "optional-plugin"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toContain("chat-mode-narrator");
      expect(body.activePlugins).toContain("scene-cast");
      expect(body.activePlugins).toContain("scene-prompts");
      expect(body.activePlugins).toContain("character-blueprint");
      expect(body.activePlugins).toContain("character-presence");
      expect(body.activePlugins).toContain("player-identity");
      expect(body.activePlugins).toContain("living-world-rules");
      expect(body.activePlugins).toContain("branch-reply");
      expect(body.activePlugins).not.toContain("optional-plugin");
      expect(body.activePlugins).not.toContain("narrator");

      const session = await store.getSession("sess-chat-create");
      expect(session?.activePlugins).toContain("chat-mode-narrator");
      expect(session?.activePlugins).toContain("scene-cast");
      expect(session?.activePlugins).toContain("scene-prompts");
      expect(session?.activePlugins).toContain("character-blueprint");
      expect(session?.activePlugins).toContain("character-presence");
      expect(session?.activePlugins).toContain("player-identity");
      expect(session?.activePlugins).toContain("living-world-rules");
      expect(session?.activePlugins).toContain("branch-reply");
      expect(session?.activePlugins).not.toContain("narrator");
    });

    it("resolves plugin dependencies and conflicts from manifest relations", async () => {
      registry.register(
        makeEntry({
          id: "relation-source",
          summary: makeSummary({
            id: "relation-source",
            name: "Relation Source",
            relations: {
              requires: [{ plugin: "relation-required" }],
              conflicts: [{ target: { plugin: "relation-conflict" } }],
            },
          }),
          source: "official",
        }),
      );
      registry.register(
        makeEntry({
          id: "relation-required",
          summary: makeSummary({
            id: "relation-required",
            name: "Relation Required",
          }),
          source: "official",
        }),
      );
      registry.register(
        makeEntry({
          id: "relation-conflict",
          summary: makeSummary({
            id: "relation-conflict",
            name: "Relation Conflict",
          }),
          source: "official",
        }),
      );

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-relations-create",
          plugins: ["relation-source", "relation-conflict"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toContain("relation-source");
      expect(body.activePlugins).toContain("relation-required");
      expect(body.activePlugins).not.toContain("relation-conflict");
    });

    it("keeps a requested plugin when an existing active plugin declares the conflict", async () => {
      registry.register(
        makeEntry({
          id: "default-engine",
          summary: makeSummary({
            id: "default-engine",
            name: "Default Engine",
            relations: {
              conflicts: ["alternate-engine"],
            },
          }),
          source: "community",
        }),
      );
      registry.register(
        makeEntry({
          id: "alternate-engine",
          summary: makeSummary({
            id: "alternate-engine",
            name: "Alternate Engine",
          }),
          source: "community",
        }),
      );
      await store.createSession({
        id: "sess-reverse-conflict",
        worldId: null,
        status: "active",
        turnCount: 1,
        preGameCompleted: [],
        presetId: null,
        activePlugins: ["default-engine"],
        createdAt: new Date().toISOString(),
      });
      const approval = rpcApprovalGate.evaluate({
        sessionId: "sess-reverse-conflict",
        pluginId: "alternate-engine",
        action: "covel:plugin-server-code",
        payload: {},
        trustLevel: "community",
      });
      if (approval.status !== "pending") {
        throw new Error("expected community enable approval");
      }
      rpcApprovalGate.decide({
        approvalId: approval.approvalId,
        decision: "allow",
        scope: "session",
        decidedAt: new Date().toISOString(),
      });

      const res = await app.request(
        "/api/sessions/sess-reverse-conflict/plugins/enable",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "alternate-engine" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { active: string[] };
      expect(body.active).toContain("alternate-engine");
      expect(body.active).not.toContain("default-engine");
    });

    it("does not let community conflicts remove required core plugins", async () => {
      registry.register(
        makeEntry({
          id: "unsafe-community",
          summary: makeSummary({
            id: "unsafe-community",
            name: "Unsafe Community",
            relations: {
              conflicts: ["pregame"],
            },
          }),
          source: "community",
        }),
      );

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-core-conflict-create",
          plugins: ["unsafe-community"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toContain("pregame");
      expect(body.activePlugins).toContain("narrator");
      expect(body.activePlugins).not.toContain("unsafe-community");
    });

    it("removes plugins whose required dependencies were removed by conflicts", async () => {
      registry.register(
        makeEntry({
          id: "dependent-plugin",
          summary: makeSummary({
            id: "dependent-plugin",
            name: "Dependent Plugin",
            relations: {
              requires: ["required-plugin"],
            },
          }),
          source: "official",
        }),
      );
      registry.register(
        makeEntry({
          id: "required-plugin",
          summary: makeSummary({
            id: "required-plugin",
            name: "Required Plugin",
          }),
          source: "official",
        }),
      );
      registry.register(
        makeEntry({
          id: "conflicting-plugin",
          summary: makeSummary({
            id: "conflicting-plugin",
            name: "Conflicting Plugin",
            relations: {
              conflicts: ["required-plugin"],
            },
          }),
          source: "official",
        }),
      );

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-unsatisfied-requires-create",
          plugins: ["dependent-plugin", "conflicting-plugin"],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toContain("conflicting-plugin");
      expect(body.activePlugins).not.toContain("required-plugin");
      expect(body.activePlugins).not.toContain("dependent-plugin");
    });

    it("imports world character blueprints when creating a session", async () => {
      await store.upsertWorld({
        id: "academy-world",
        name: "Academy World",
        description: "Test world",
        metadata: {
          characterBlueprints: [
            {
              schemaVersion: 1,
              id: "test-heroine",
              name: "Test Heroine",
              role: "npc",
              description: "A seeded NPC.",
              attributes: { affection: 10 },
              instantiate: {
                characterId: "npc-test-heroine",
                type: "npc",
              },
            },
          ],
        },
        createdAt: new Date().toISOString(),
      });

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-academy",
          worldId: "academy-world",
          plugins: ["chat-mode-narrator"],
        }),
      });

      expect(res.status).toBe(200);
      const characters = await store.listCharacters("sess-academy");
      expect(characters).toEqual([
        expect.objectContaining({
          id: "sess-academy-npc-test-heroine",
          name: "Test Heroine",
          type: "npc",
          description: "A seeded NPC.",
          fields: { affection: 10 },
        }),
      ]);

      const blueprint = await store.getPluginData(
        "sess-academy",
        "character-blueprint",
        "blueprints",
        "test-heroine",
      );
      expect(blueprint?.value).toMatchObject({
        sourceWorldId: "academy-world",
        instantiatedCharacterId: "sess-academy-npc-test-heroine",
        blueprint: {
          id: "test-heroine",
          name: "Test Heroine",
        },
      });
      const blueprintMirror = await store.getPluginData(
        "sess-academy",
        "character-blueprint",
        "characters",
        "sess-academy-npc-test-heroine",
      );
      expect(blueprintMirror?.value).toMatchObject({
        id: "sess-academy-npc-test-heroine",
        name: "Test Heroine",
      });
      // Mirror targets are capability-discovered (dataSchemas.characters
      // .acceptsWorldData). char-creator does not declare it and reads the
      // canonical `session.characters` table, so it receives no plugin-data
      // mirror — the framework no longer hardcodes a char-creator write.
    });

    it("scopes imported blueprint character ids per session", async () => {
      await store.upsertWorld({
        id: "academy-world-scoped",
        name: "Academy World Scoped",
        description: "Test world",
        metadata: {
          characterBlueprints: [
            {
              schemaVersion: 1,
              id: "test-heroine-scoped",
              name: "Test Heroine Scoped",
              role: "npc",
              instantiate: {
                characterId: "npc-test-heroine-scoped",
                type: "npc",
              },
            },
          ],
        },
        createdAt: new Date().toISOString(),
      });

      for (const sessionId of ["sess-academy-a", "sess-academy-b"]) {
        const res = await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: sessionId,
            worldId: "academy-world-scoped",
            plugins: ["chat-mode-narrator"],
          }),
        });
        expect(res.status).toBe(200);
        const scopedId = `${sessionId}-npc-test-heroine-scoped`;
        const characters = await store.listCharacters(sessionId);
        expect(characters.map((character) => character.id)).toContain(scopedId);
        // Mirror lands in capability-discovered targets (character-blueprint
        // declares dataSchemas.characters.acceptsWorldData), scoped per session.
        const blueprintMirror = await store.getPluginData(
          sessionId,
          "character-blueprint",
          "characters",
          scopedId,
        );
        expect(blueprintMirror?.value).toMatchObject({
          id: scopedId,
          name: "Test Heroine Scoped",
        });
      }
    });

    it("enabling chat-mode-narrator replaces default narrator and adds the chat mode bundle", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/enable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "chat-mode-narrator" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { active: string[] };
      expect(body.active).toContain("chat-mode-narrator");
      expect(body.active).toContain("scene-cast");
      expect(body.active).toContain("scene-prompts");
      expect(body.active).toContain("character-blueprint");
      expect(body.active).toContain("character-presence");
      expect(body.active).toContain("player-identity");
      expect(body.active).toContain("living-world-rules");
      expect(body.active).toContain("branch-reply");
      expect(body.active).toContain("optional-plugin");
      expect(body.active).not.toContain("narrator");

      const session = await store.getSession(SESSION_ID);
      expect(session?.activePlugins).toEqual(body.active);
    });

    it("requires a session grant before enabling community server code", async () => {
      const requestEnable = () =>
        app.request(`/api/sessions/${SESSION_ID}/plugins/enable`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "optional-plugin" }),
        });

      const pendingResponse = await requestEnable();
      expect(pendingResponse.status).toBe(202);
      const pending = (await pendingResponse.json()) as {
        approvalId: string;
      };
      rpcApprovalGate.decide({
        approvalId: pending.approvalId,
        decision: "allow",
        scope: "session",
        decidedAt: new Date().toISOString(),
      });

      const allowedResponse = await requestEnable();
      expect(allowedResponse.status).toBe(200);
      // `hasGrant` is exact-action only — enabling server code grants
      // exactly the COMMUNITY_SERVER_CODE_ACTION, nothing broader.
      expect(
        rpcApprovalGate.hasGrant(
          SESSION_ID,
          "optional-plugin",
          COMMUNITY_SERVER_CODE_ACTION,
        ),
      ).toBe(true);
    });

    it("should return 403 when attempting to disable a core-plugin", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/disable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "narrator" }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/core/i);
    });

    it("should allow disabling a non-core plugin", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/disable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "optional-plugin" }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Real route returns `active`, not `activePlugins`
      expect(body.active as string[]).not.toContain("optional-plugin");
    });

    it("should still include narrator in active list after failed disable", async () => {
      await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "narrator" }),
      });
      const session = await store.getSession(SESSION_ID);
      expect(session!.activePlugins).toContain("narrator");
    });

    it("uses discovery trust metadata when deciding whether a plugin is core", async () => {
      registry.register(
        makeEntry({
          id: "forged-core",
          summary: makeSummary({
            id: "forged-core",
            name: "Forged Core",
            pluginType: "core-plugin",
          }),
          source: "community",
        }),
      );
      await store.updateSession(SESSION_ID, {
        activePlugins: ["narrator", "optional-plugin", "forged-core"],
        updatedAt: new Date().toISOString(),
      });

      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/disable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "forged-core" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { active: string[] };
      expect(body.active).toEqual(["narrator", "optional-plugin"]);
    });
  });

  describe("H3: pluginId validation on disable route", () => {
    it("should return 400 when pluginId is missing in disable body", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/disable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/pluginId/);
    });

    it("should return 404 when session does not exist", async () => {
      const res = await app.request(
        `/api/sessions/no-such-session/plugins/disable`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: "optional-plugin" }),
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
