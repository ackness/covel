/**
 * Tests for session plugin enable/disable routes.
 *
 * Mounts the REAL sessionRoutes from src/routes/api/session.ts so we test
 * production code, not a hand-copied shadow. (Fix for 2026-04-12 audit
 * Finding 5: the previous version of this file declared its own Hono routes
 * inline that drifted from the real implementation.)
 *
 * Covers:
 * - explicit plugin selection and core defaults (enforced by manifest.pluginType,
 *       not hardcoded plugin IDs — see AGENTS.md framework-plugin isolation)
 * - H3: pluginId body validation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  createRpcApprovalGate,
  type RpcApprovalGate,
} from "@covel/approval";
import {
  createPluginRegistry,
  parsePluginMd,
  type PluginRegistry,
  type PluginSummary,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

// ── Helpers ──────────────────────────────────────────────────────

type TestSummary = PluginSummary &
  Pick<
    import("@covel/shared").PluginManifest,
    "provides" | "requires" | "conflicts"
  >;
function makeSummary(overrides?: Partial<TestSummary>): TestSummary {
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
  const id = overrides?.id ?? "test-plugin";
  const summary = (overrides?.summary ?? makeSummary()) as TestSummary;
  const root = parsePluginMd(
    `---\n${JSON.stringify({ id, kind: summary.pluginType === "core-plugin" ? "core" : "plugin", description: summary.description, provides: [...(summary.provides ?? []).map((value) => (typeof value === "string" && summary.pluginType === "core-plugin" ? { contract: value, default: true } : value)), `${id}@1`], requires: summary.requires, conflicts: summary.conflicts })}\n---\n`,
    `${id}/PLUGIN.md`,
  );
  return {
    id: "test-plugin",
    packageManifest: root,
    manifests: [],
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
  activatePluginServerCode: (
    pluginId: string,
  ) => Promise<void> = async () => {},
): Hono {
  const app = new Hono();
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    c.set("activatePluginServerCode", activatePluginServerCode);
    c.set("sessionLock", sessionLock);
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

  it("preserves community selection on create and exposes approval after restart", async () => {
    const activated = vi.fn(async () => {});
    app = createTestApp(registry, store, rpcApprovalGate, activated);
    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "selected-community",
        plugins: ["optional-plugin"],
      }),
    });
    expect(response.status).toBe(201);
    const session = (await store.getSession("selected-community"))!;
    expect(session.activePlugins).not.toContain("optional-plugin");
    expect(session.metadata?.pluginSelection).toEqual({
      requested: ["optional-plugin"],
      excluded: [],
    });
    expect(activated).not.toHaveBeenCalled();
    const list = async () =>
      (
        await (
          await app.request("/api/sessions/selected-community/plugins")
        ).json()
      ).items;
    expect(await list()).toContainEqual(
      expect.objectContaining({
        id: "optional-plugin",
        active: false,
        approvalRequired: true,
      }),
    );
    const pending = await (
      await app.request(
        "/api/sessions/selected-community/plugins/optional-plugin",
        { method: "PUT" },
      )
    ).json();
    rpcApprovalGate.decide(
      {
        approvalId: pending.approvalId,
        decision: "allow",
        scope: "session",
        decidedAt: new Date().toISOString(),
      },
      sessionApprovalScope(session, "optional-plugin"),
    );
    expect(
      (
        await app.request(
          "/api/sessions/selected-community/plugins/optional-plugin",
          { method: "PUT" },
        )
      ).status,
    ).toBe(200);
    expect(await list()).toContainEqual(
      expect.objectContaining({
        id: "optional-plugin",
        active: true,
        sessionState: "active",
      }),
    );
    app = createTestApp(registry, store, createRpcApprovalGate(), activated);
    expect(await list()).toContainEqual(
      expect.objectContaining({
        id: "optional-plugin",
        active: false,
        approvalRequired: true,
      }),
    );
    expect(
      (
        await app.request(
          "/api/sessions/selected-community/plugins/optional-plugin",
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    expect(await list()).toContainEqual(
      expect.objectContaining({
        id: "optional-plugin",
        active: false,
        sessionState: "inactive",
      }),
    );
  });

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
          provides: ["narrative-engine@1"],
          conflicts: ["chat-mode-narrator@1"],
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
          provides: ["narrative-engine@1"],
          requires: [
            "scene-cast@1",
            "scene-prompts@1",
            "character-blueprint@1",
            "character-presence@1",
            "player-identity@1",
            "living-world-rules@1",
            "branch-reply@1",
          ],
          conflicts: ["narrator@1"],
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
            namespace: "blueprints",
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/blueprints.schema.json",
          },
          characters: {
            namespace: "characters",
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
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        pluginSelection: {
          requested: ["narrator", "optional-plugin"],
          excluded: [],
        },
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 1,

      activePlugins: ["narrator", "optional-plugin"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  describe("GET plugin projection", () => {
    it("filters unapproved plugins without mutating session or registry state", async () => {
      const updateSession = vi.spyOn(store, "updateSession");
      const applyActivations = vi.spyOn(registry, "applyPersistedActivations");

      const response = await app.request(`/api/sessions/${SESSION_ID}/plugins`);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ id: string; active: boolean }>;
      };
      expect(body.items.find((item) => item.id === "narrator")?.active).toBe(
        true,
      );
      expect(
        body.items.find((item) => item.id === "optional-plugin")?.active,
      ).toBe(false);
      expect(updateSession).not.toHaveBeenCalled();
      expect(applyActivations).not.toHaveBeenCalled();
      expect((await store.getSession(SESSION_ID))?.activePlugins).toEqual([
        "narrator",
        "optional-plugin",
      ]);
    });
  });

  describe("explicit plugin selection and core defaults", () => {
    it("includes required core plugins when creating a session from a partial plugin list", async () => {
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-core-create",
          plugins: ["optional-plugin"],
        }),
      });

      expect(res.status).toBe(201);
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

      expect(res.status).toBe(201);
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

    it("resolves versioned required contracts from explicit package declarations", async () => {
      registry.register(
        makeEntry({
          id: "relation-source",
          summary: makeSummary({
            id: "relation-source",
            name: "Relation Source",
            requires: ["relation-required@1"],
            conflicts: ["relation-conflict@1"],
          }),
          source: "builtin",
        }),
      );
      registry.register(
        makeEntry({
          id: "relation-required",
          summary: makeSummary({
            id: "relation-required",
            name: "Relation Required",
          }),
          source: "builtin",
        }),
      );
      registry.register(
        makeEntry({
          id: "relation-conflict",
          summary: makeSummary({
            id: "relation-conflict",
            name: "Relation Conflict",
          }),
          source: "builtin",
        }),
      );

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-relations-create",
          plugins: ["relation-source"],
        }),
      });

      expect(res.status).toBe(201);
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
            conflicts: ["alternate-engine@1"],
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
        phase: "playing",
        setupRuntimes: {},
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        id: "sess-reverse-conflict",
        status: "active",
        locale: "zh-CN",
        completedPlayerTurns: 1,

        activePlugins: ["default-engine"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const reverseConflictSession = await store.getSession(
        "sess-reverse-conflict",
      );
      if (!reverseConflictSession) throw new Error("expected session");
      const reverseScope = sessionApprovalScope(
        reverseConflictSession,
        "alternate-engine",
      );
      const approval = rpcApprovalGate.evaluate({
        sessionId: "sess-reverse-conflict",
        sessionScope: reverseScope,
        pluginId: "alternate-engine",
        action: "covel:plugin-server-code",
        payload: {},
        trustLevel: "community",
      });
      if (approval.status !== "pending") {
        throw new Error("expected community enable approval");
      }
      rpcApprovalGate.decide(
        {
          approvalId: approval.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        reverseScope,
      );

      const res = await app.request(
        "/api/sessions/sess-reverse-conflict/plugins/alternate-engine",
        {
          method: "PUT",
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePluginIds: string[] };
      expect(body.activePluginIds).toContain("alternate-engine");
      expect(body.activePluginIds).not.toContain("default-engine");
    });

    it("does not let community conflicts remove required core plugins", async () => {
      registry.register(
        makeEntry({
          id: "unsafe-community",
          summary: makeSummary({
            id: "unsafe-community",
            name: "Unsafe Community",
            conflicts: ["pregame@1"],
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

      expect(res.status).toBe(201);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toContain("pregame");
      expect(body.activePlugins).toContain("narrator");
      expect(body.activePlugins).not.toContain("unsafe-community");
    });

    it("rejects creation when conflicts make a requested dependency unavailable", async () => {
      registry.register(
        makeEntry({
          id: "dependent-plugin",
          summary: makeSummary({
            id: "dependent-plugin",
            name: "Dependent Plugin",
            requires: ["required-plugin@1"],
          }),
          source: "builtin",
        }),
      );
      registry.register(
        makeEntry({
          id: "required-plugin",
          summary: makeSummary({
            id: "required-plugin",
            name: "Required Plugin",
          }),
          source: "builtin",
        }),
      );
      registry.register(
        makeEntry({
          id: "conflicting-plugin",
          summary: makeSummary({
            id: "conflicting-plugin",
            name: "Conflicting Plugin",
            conflicts: ["required-plugin@1"],
          }),
          source: "builtin",
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

      expect(res.status).toBe(400);
      expect(
        await store.getSession("sess-unsatisfied-requires-create"),
      ).toBeNull();
      expect(await res.text()).toContain("Conflicts");
    });

    it("treats a world's required contracts as a requirer on create and on later toggles", async () => {
      registry.register(
        makeEntry({
          id: "world-dice",
          summary: makeSummary({
            id: "world-dice",
            name: "World Dice",
            provides: ["action-check@1"],
          }),
          source: "builtin",
        }),
      );
      await store.upsertWorld({
        id: "tabletop-world",
        name: "Tabletop World",
        description: "Test world",
        metadata: { pluginPolicy: { requires: ["action-check@1"] } },
        createdAt: "2026-10-03T00:00:00.000Z",
      });

      const created = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-world-requires",
          worldId: "tabletop-world",
          plugins: [],
        }),
      });
      expect(created.status).toBe(201);
      const session = await store.getSession("sess-world-requires");
      expect(session?.activePlugins).toContain("world-dice");
      expect(session?.metadata?.pluginSelection).toEqual({
        requested: [],
        excluded: [],
        requiredContracts: ["action-check@1"],
      });

      // Turning the provider off is the player's choice; the requirement stays
      // recorded so a later resolution still knows what the world needs.
      const disabled = await app.request(
        "/api/sessions/sess-world-requires/plugins/world-dice",
        { method: "DELETE" },
      );
      expect(disabled.status).toBe(200);
      const after = await store.getSession("sess-world-requires");
      expect(after?.activePlugins).not.toContain("world-dice");
      expect(after?.metadata?.pluginSelection).toMatchObject({
        excluded: ["world-dice"],
        requiredContracts: ["action-check@1"],
      });
    });

    it("refuses creation when no installed plugin provides a world-required contract", async () => {
      await store.upsertWorld({
        id: "unplayable-world",
        name: "Unplayable World",
        description: "Test world",
        metadata: { pluginPolicy: { requires: ["absent-check@1"] } },
        createdAt: "2026-10-03T00:00:00.000Z",
      });

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-unmet-world",
          worldId: "unplayable-world",
          plugins: [],
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "world_requirement_unmet",
        details: { contract: "absent-check@1", code: "missing-provider" },
      });
      expect(await store.getSession("sess-unmet-world")).toBeNull();
    });

    it("creates the session in a language the world has an edition for", async () => {
      await store.upsertWorld({
        id: "bilingual-world",
        name: "双语世界",
        description: "Test world",
        locale: "zh-CN",
        metadata: { supportedLocales: ["zh-CN", "en-US"] },
        createdAt: new Date().toISOString(),
      });
      await store.upsertWorld({
        id: "chinese-world",
        name: "中文世界",
        description: "Test world",
        locale: "zh-CN",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      const create = async (id: string, worldId: string, locale: string) => {
        const res = await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, worldId, locale, plugins: ["narrator"] }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as {
          locale: string;
          requestedLocale?: string;
        };
      };

      // The world has an English edition: the session is English.
      const english = await create("sess-en", "bilingual-world", "en-US");
      expect(english.locale).toBe("en-US");
      expect(english.requestedLocale).toBeUndefined();

      // The world is Chinese only. An English session would put Chinese lore
      // beside a request for English output, so the session is Chinese and
      // the response names the language that was asked for.
      const fallback = await create("sess-zh", "chinese-world", "en-US");
      expect(fallback.locale).toBe("zh-CN");
      expect(fallback.requestedLocale).toBe("en-US");
      expect((await store.getSession("sess-zh"))?.locale).toBe("zh-CN");
    });

    it("names the active plugins that have no text in the session's language", async () => {
      registry.register(
        makeEntry({
          id: "translated-plugin",
          summary: makeSummary({ id: "translated-plugin", name: "Translated" }),
          source: "builtin",
          languages: { text: ["en", "zh"], instructions: ["en"] },
        }),
      );
      const create = async (id: string, locale: string) => {
        const res = await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            locale,
            plugins: ["narrator", "translated-plugin"],
          }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as { pluginsWithoutLocale?: string[] };
      };

      // `narrator` and the default `pregame` are registered with English
      // only. The session is created all the same: their panels show English.
      expect(
        (await create("sess-zh-labels", "zh-CN")).pluginsWithoutLocale,
      ).toEqual(["narrator", "pregame"]);
      // Every plugin has English.
      expect(
        (await create("sess-en-labels", "en-US")).pluginsWithoutLocale,
      ).toBeUndefined();
    });

    it("imports portable lorebook entries from a store-only generated world", async () => {
      await store.upsertWorld({
        id: "portable-generated-world",
        name: "Portable Generated World",
        description: "Test world",
        metadata: {
          source: "server-store",
          embeddedLorebook: [
            {
              id: "always-on-rule",
              content: "Every promise creates a visible silver thread.",
              strategy: "constant",
              position: "before_plugin",
              extra: { sourceKind: "rule" },
            },
            {
              id: "mirror-gate",
              content: "The mirror gate opens only when addressed by name.",
              strategy: "selective",
              keys: ["mirror", "gate"],
            },
          ],
        },
        createdAt: new Date().toISOString(),
      });

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "sess-portable-generated",
          worldId: "portable-generated-world",
          plugins: ["narrator"],
        }),
      });

      expect(res.status).toBe(201);
      await expect(
        store.listSessionLorebookEntries("sess-portable-generated"),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "always-on-rule",
            strategy: "constant",
            position: "before_plugin",
          }),
          expect.objectContaining({
            id: "mirror-gate",
            strategy: "selective",
            keys: ["mirror", "gate"],
          }),
        ]),
      );
    });

    it("enabling chat-mode-narrator replaces default narrator and adds the chat mode bundle", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/chat-mode-narrator`,
        {
          method: "PUT",
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePluginIds: string[] };
      expect(body.activePluginIds).toContain("chat-mode-narrator");
      expect(body.activePluginIds).toContain("scene-cast");
      expect(body.activePluginIds).toContain("scene-prompts");
      expect(body.activePluginIds).toContain("character-blueprint");
      expect(body.activePluginIds).toContain("character-presence");
      expect(body.activePluginIds).toContain("player-identity");
      expect(body.activePluginIds).toContain("living-world-rules");
      expect(body.activePluginIds).toContain("branch-reply");
      expect(body.activePluginIds).not.toContain("optional-plugin");
      expect(body.activePluginIds).not.toContain("narrator");

      const session = await store.getSession(SESSION_ID);
      expect(session?.activePlugins).toEqual(body.activePluginIds);
    });

    it("serializes concurrent plugin enables and preserves both updates", async () => {
      for (const pluginId of ["concurrent-plugin-a", "concurrent-plugin-b"]) {
        registry.register(
          makeEntry({
            id: pluginId,
            summary: makeSummary({ id: pluginId, pluginType: "plugin" }),
            source: "builtin",
          }),
        );
      }

      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const getSession = vi.spyOn(store, "getSession");
      app = createTestApp(
        registry,
        store,
        rpcApprovalGate,
        async (pluginId) => {
          if (pluginId === "concurrent-plugin-a") {
            markFirstStarted();
            await firstGate;
          }
        },
      );

      const enable = (pluginId: string) =>
        app.request(`/api/sessions/${SESSION_ID}/plugins/${pluginId}`, {
          method: "PUT",
        });
      const first = enable("concurrent-plugin-a");
      await firstStarted;
      const readsBeforeSecond = getSession.mock.calls.length;
      const second = enable("concurrent-plugin-b");
      await vi.waitFor(() => {
        expect(getSession.mock.calls.length).toBeGreaterThan(readsBeforeSecond);
      });

      releaseFirst();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect((await store.getSession(SESSION_ID))?.activePlugins).toEqual(
        expect.arrayContaining(["concurrent-plugin-a", "concurrent-plugin-b"]),
      );
    });

    it("keeps the registry unchanged when enabling fails to persist", async () => {
      registry.register(
        makeEntry({
          id: "persist-failure-plugin",
          summary: makeSummary({
            id: "persist-failure-plugin",
            pluginType: "plugin",
          }),
          source: "builtin",
        }),
      );
      const applySpy = vi.spyOn(registry, "applyPersistedActivations");
      vi.spyOn(store, "updateSession").mockRejectedValueOnce(
        new Error("simulated persistence failure"),
      );

      const response = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/persist-failure-plugin`,
        { method: "PUT" },
      );

      expect(response.status).toBe(500);
      // The mutation path ran, but its persist-first contract kept the
      // in-memory mirror unchanged when the store write failed.
      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(registry.getActivePlugins(SESSION_ID)).not.toContain(
        "persist-failure-plugin",
      );
      expect((await store.getSession(SESSION_ID))?.activePlugins).not.toContain(
        "persist-failure-plugin",
      );
    });

    it("requires a session grant before enabling community server code", async () => {
      const requestEnable = () =>
        app.request(`/api/sessions/${SESSION_ID}/plugins/optional-plugin`, {
          method: "PUT",
        });

      const pendingResponse = await requestEnable();
      expect(pendingResponse.status).toBe(202);
      const pending = (await pendingResponse.json()) as {
        approvalId: string;
      };
      const pendingSession = await store.getSession(SESSION_ID);
      if (!pendingSession) throw new Error("expected session");
      const pendingScope = sessionApprovalScope(
        pendingSession,
        "optional-plugin",
      );
      rpcApprovalGate.decide(
        {
          approvalId: pending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        pendingScope,
      );

      const allowedResponse = await requestEnable();
      expect(allowedResponse.status).toBe(200);
      // `hasGrant` is exact-action only — enabling server code grants
      // exactly the COMMUNITY_SERVER_CODE_ACTION, nothing broader.
      expect(
        rpcApprovalGate.hasGrant(
          SESSION_ID,
          "optional-plugin",
          COMMUNITY_SERVER_CODE_ACTION,
          sessionApprovalScope(
            (await store.getSession(SESSION_ID))!,
            "optional-plugin",
          ),
        ),
      ).toBe(true);
    });

    it("disables a core plugin and persists an explicit exclusion", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/narrator`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect(
        (await store.getSession(SESSION_ID))?.metadata?.pluginSelection,
      ).toEqual({ requested: ["optional-plugin"], excluded: ["narrator"] });
    });

    it("refuses to disable the plugin that holds the session's dimensions", async () => {
      // Turns, snapshots and browser checkpoints all require the bound
      // provider; dropping it would leave a session none of them accept.
      await store.updateSession(SESSION_ID, {
        metadata: { _dimensionProviderPluginId: "narrator" },
      });
      const before = (await store.getSession(SESSION_ID))!;

      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/narrator`,
        { method: "DELETE" },
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "dimension_provider_required",
      });
      const after = (await store.getSession(SESSION_ID))!;
      expect(after.activePlugins).toEqual(before.activePlugins);
      expect(after.metadata?.pluginSelection).toEqual(
        before.metadata?.pluginSelection,
      );
      // A change that keeps the provider active is still accepted.
      const other = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/optional-plugin`,
        { method: "DELETE" },
      );
      expect(other.status).toBe(200);
      expect((await store.getSession(SESSION_ID))!.activePlugins).toContain(
        "narrator",
      );
    });

    it("should allow disabling a non-core plugin", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/optional-plugin`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.activePluginIds as string[]).not.toContain("optional-plugin");
    });

    it("keeps the registry unchanged when disabling fails to persist", async () => {
      // Seed the mirror the way a successful enable/create would leave it.
      registry.syncSessionActivations(SESSION_ID, [
        "narrator",
        "optional-plugin",
      ]);
      const applyActivations = vi.spyOn(registry, "applyPersistedActivations");
      vi.spyOn(store, "updateSession").mockRejectedValueOnce(
        new Error("simulated persistence failure"),
      );

      const response = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/optional-plugin`,
        {
          method: "DELETE",
        },
      );

      expect(response.status).toBe(500);
      // The mutation path ran, but its persist-first contract kept the
      // in-memory mirror unchanged when the store write failed.
      expect(applyActivations).toHaveBeenCalledTimes(1);
      expect(registry.getActivePlugins(SESSION_ID)).toContain(
        "optional-plugin",
      );
      expect((await store.getSession(SESSION_ID))?.activePlugins).toContain(
        "optional-plugin",
      );
    });

    it("keeps an explicitly disabled core out of subsequent projections", async () => {
      await app.request(`/api/sessions/${SESSION_ID}/plugins/narrator`, {
        method: "DELETE",
      });
      const session = await store.getSession(SESSION_ID);
      expect(session!.activePlugins).not.toContain("narrator");
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
        `/api/sessions/${SESSION_ID}/plugins/forged-core`,
        {
          method: "DELETE",
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePluginIds: string[] };
      expect(body.activePluginIds).toEqual(["narrator", "pregame"]);
    });
  });

  describe("plugin resource validation", () => {
    it("returns 200 when disabling an unknown inactive plugin id", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/plugins/not-active`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(200);
    });

    it("should return 404 when session does not exist", async () => {
      const res = await app.request(
        `/api/sessions/no-such-session/plugins/optional-plugin`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
