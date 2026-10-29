// @vitest-environment node
/**
 * Every API route and the host actions it needs (F-001 prevention).
 *
 * The table below names, for each route the server serves, the actions it
 * asks of the host profile (`src/host-profile.ts`). The test assembles the
 * routes exactly as `app.ts` mounts them (`mountApiRoutes`) and checks:
 *
 * - the table and the served routes are the same list, so a new route fails
 *   here until someone decides what it needs;
 * - each route that asks before anything else is refused by the profile in
 *   the request's context, with the answer that profile gives for the
 *   route's first action. The environment says `self` with no token, which
 *   opens everything; the profile closes every action with a code of its
 *   own. A route that decides access from the environment answers as open
 *   and fails;
 * - no server file but the host profile reads the deployment variables.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { createAiStack } from "../../src/ai-setup.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { mountApiRoutes } from "../../src/host-routes.js";
import {
  HOST_ACTIONS,
  deriveHostProfile,
  hostProfileMiddleware,
  type HostAccessRule,
  type HostAction,
  type HostProfile,
} from "../../src/host-profile.js";
import { closeTestApi } from "../helpers/close-api.js";

interface RouteAccess {
  /**
   * The host actions the route asks, the first one before it reads or
   * changes anything for the caller.
   */
  readonly needs: readonly HostAction[];
  /** The route asks its actions only in this case; the probe skips it. */
  readonly onlyWhen?: string;
  /** A refusal is an answer without the guarded part, not an error. */
  readonly refusal?: "empty-list" | "redacted";
  /** What the probe sends to reach the first check. */
  readonly probe?: { readonly query?: string; readonly body?: unknown };
}

const PUBLIC: RouteAccess = { needs: [] };
const needs = (...actions: HostAction[]): RouteAccess => ({ needs: actions });
const SESSION = needs("session.access");
const S = "s-probe";
const W = "w-probe";

/** Every route the server serves. Keep it sorted by module, as mounted. */
const ROUTES: Record<string, RouteAccess> = {
  "GET /plugin-assets/:pluginId/:digest/*": PUBLIC,
  // ── Sessions ──────────────────────────────────────────────────
  "GET /api/sessions": { ...needs("session.list"), refusal: "empty-list" },
  "POST /api/sessions": needs("session.create"),
  "GET /api/sessions/:id": SESSION,
  "PATCH /api/sessions/:id": SESSION,
  "DELETE /api/sessions/:id": SESSION,
  "GET /api/sessions/:id/view": SESSION,
  "GET /api/sessions/:id/media-token": SESSION,
  "GET /api/sessions/:id/plugins": SESSION,
  "PUT /api/sessions/:id/plugins/:pluginId": {
    ...needs("session.access", "plugin.community"),
    onlyWhen: "plugin.community: enabling a community plugin",
  },
  "DELETE /api/sessions/:id/plugins/:pluginId": SESSION,
  "POST /api/sessions/:id/plugins/:pluginId/resume-fault": SESSION,
  "GET /api/sessions/:id/memory-index": SESSION,
  "POST /api/sessions/:id/memory-index/rebuild": SESSION,
  "PATCH /api/sessions/:id/seats/:seatId": SESSION,
  "GET /api/sessions/:id/action-kinds": SESSION,
  "GET /api/sessions/:id/state": SESSION,
  "GET /api/sessions/:id/state-patches": SESSION,
  "GET /api/sessions/:id/messages": SESSION,
  "GET /api/sessions/:id/messages/page": SESSION,
  "POST /api/sessions/:id/messages/sync": SESSION,
  "GET /api/sessions/:id/characters": SESSION,
  "POST /api/sessions/:id/characters": SESSION,
  "GET /api/sessions/:id/plugin-data": SESSION,
  "GET /api/sessions/:id/plugin-data/:pluginId": SESSION,
  "GET /api/sessions/:id/plugin-data/:pluginId/_index": SESSION,
  "GET /api/sessions/:id/plugin-data/:pluginId/:namespace": SESSION,
  "GET /api/sessions/:id/plugin-data/:pluginId/:namespace/:key": SESSION,
  "PUT /api/sessions/:id/plugin-data/:pluginId/:namespace/:key": SESSION,
  "DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key": SESSION,
  "GET /api/sessions/:id/ui-slots": SESSION,
  "GET /api/sessions/:id/media/image-flow": SESSION,
  "GET /api/sessions/:id/suspensions": SESSION,
  // These two read their body before the owner check.
  "POST /api/sessions/:id/suspensions/:suspensionId/resume": {
    ...SESSION,
    probe: { body: { data: {} } },
  },
  "DELETE /api/sessions/:id/suspensions/:suspensionId": SESSION,
  "GET /api/sessions/:id/snapshots": SESSION,
  "POST /api/sessions/:id/snapshots": SESSION,
  "GET /api/sessions/:id/snapshots/:snapshotId": SESSION,
  // F-204: a fork creates a session and asks what POST /api/sessions asks.
  "POST /api/sessions/:id/fork": needs("session.create", "session.access"),
  "GET /api/sessions/:id/lorebook": SESSION,
  "POST /api/sessions/:id/lorebook": SESSION,
  "PUT /api/sessions/:id/lorebook/:entryId": SESSION,
  "PATCH /api/sessions/:id/lorebook/:entryId": SESSION,
  "DELETE /api/sessions/:id/lorebook/:entryId": SESSION,
  "GET /api/sessions/:id/runtime-outputs": SESSION,
  "GET /api/sessions/:id/runtime-outputs/:outputId": SESSION,
  "GET /api/sessions/:id/runtime-outputs/:outputId/full-prompt": SESSION,
  "GET /api/sessions/:id/interaction-records": SESSION,
  "GET /api/sessions/:id/runtime-jobs": SESSION,
  "POST /api/sessions/:id/runtime-jobs/:jobId/cancel": SESSION,
  "POST /api/sessions/:id/runtime-jobs/:jobId/retry": SESSION,
  "POST /api/sessions/:id/plugin-rpc": {
    ...needs("session.access", "plugin.community"),
    onlyWhen: "plugin.community: the call runs a community plugin",
  },
  "GET /api/sessions/:id/execution": SESSION,
  "POST /api/sessions/:id/steer": {
    ...SESSION,
    probe: { body: { message: "probe" } },
  },
  "POST /api/sessions/:id/abort": SESSION,
  "GET /api/sessions/:id/turns": SESSION,
  "POST /api/sessions/:id/setup/:runtimeId/retry": SESSION,
  "POST /api/sessions/:id/setup/:runtimeId/waive": SESSION,
  "GET /api/sessions/:id/approvals": SESSION,
  "DELETE /api/sessions/:id/approvals": SESSION,
  "PUT /api/sessions/:id/browser-checkpoint": {
    ...needs("session.access", "world.write"),
    probe: { body: {} },
  },
  "POST /api/sessions/:id/browser-commit": SESSION,
  "GET /api/sessions/:id/plugin-diagnostics": SESSION,
  "POST /api/approvals/:approvalId/decision": {
    ...needs("session.access", "plugin.community"),
    onlyWhen: "a pending approval names the session",
  },
  "POST /api/actions": {
    ...needs("session.access", "plugin.community"),
    probe: {
      body: {
        requestId: "req-probe",
        type: "submit_actions",
        sessionId: S,
        payload: { actions: [{ kind: "say", text: "probe" }] },
      },
    },
  },
  "POST /api/events/emit": {
    ...SESSION,
    probe: { body: { topic: "probe", sessionId: S } },
  },
  "GET /api/events/stream": { ...SESSION, probe: { query: `sessionId=${S}` } },
  "GET /api/traces/:sessionId": SESSION,
  "GET /api/traces/:sessionId/turns": SESSION,
  "GET /api/traces/:sessionId/turns/page": SESSION,
  // ── Plugins and framework ─────────────────────────────────────
  "GET /api/plugins": PUBLIC,
  "GET /api/plugins/:id": PUBLIC,
  "DELETE /api/plugins/:id": needs("host.files"),
  "POST /api/plugins/:id/reload": needs("host.files"),
  "GET /api/framework/capabilities": PUBLIC,
  "GET /api/framework/authoring": PUBLIC,
  "GET /api/plugin-flows": PUBLIC,
  "GET /api/ui-specs": {
    ...SESSION,
    onlyWhen: "session.access: ?sessionId= names a session",
    probe: { query: `sessionId=${S}` },
  },
  // ── Worlds ────────────────────────────────────────────────────
  "GET /api/worlds": PUBLIC,
  "GET /api/worlds/:id": PUBLIC,
  "POST /api/worlds": needs("world.write"),
  "PATCH /api/worlds/:id": needs("world.write"),
  "DELETE /api/worlds/:id": needs("world.write"),
  "GET /api/worlds/:id/plugin-plan": PUBLIC,
  "GET /api/worlds/:id/gallery": PUBLIC,
  "GET /api/worlds/:id/gallery/:source/:file": PUBLIC,
  "GET /api/worlds/:id/dimensions/export": PUBLIC,
  "POST /api/worlds/:id/dimensions/import": needs("world.write"),
  "POST /api/worlds/:id/restore-package": needs("world.write"),
  "POST /api/worlds/:id/translate": needs("world.generate", "world.write"),
  "POST /api/worlds/:id/world-data/preflight": {
    ...SESSION,
    onlyWhen: "session.access: the body names a session",
    probe: { body: { sessionId: S } },
  },
  "POST /api/worlds/:id/sync-data": {
    ...SESSION,
    probe: { body: { sessionId: S } },
  },
  "POST /api/worlds/:id/sync-dimensions": {
    ...SESSION,
    probe: { body: { sessionId: S } },
  },
  "POST /api/ai/generate-world": {
    ...needs("world.generate", "world.write"),
    onlyWhen: "world.write: the result is saved to the catalog",
  },
  "POST /api/ai/revise-world": {
    ...needs("world.generate", "world.write"),
    onlyWhen: "world.write: the result is saved to the catalog",
  },
  // ── Install ───────────────────────────────────────────────────
  "GET /api/install/plugins": needs("host.files"),
  "GET /api/install/worlds": needs("host.files"),
  "POST /api/install/validate/plugin": needs("host.files"),
  "POST /api/install/validate/world": needs("host.files"),
  "POST /api/install/plugin": needs("host.files"),
  "POST /api/install/plugin/github/preview": needs("host.files"),
  "POST /api/install/plugin/github": needs("host.files"),
  "POST /api/install/plugin/github/update/preview": needs("host.files"),
  "POST /api/install/plugin/github/update": needs("host.files"),
  "DELETE /api/install/plugin/github/update/:id": needs("host.files"),
  "POST /api/install/world": needs("host.files", "world.write"),
  "POST /api/install/st-import": needs("host.files", "world.write"),
  "POST /api/install/world/github/preview": needs("host.files", "world.write"),
  "POST /api/install/world/github": needs("host.files", "world.write"),
  "POST /api/install/world/github/update/preview": needs(
    "host.files",
    "world.write",
  ),
  "POST /api/install/world/github/update": needs("host.files", "world.write"),
  "DELETE /api/install/world/github/update/:id": needs(
    "host.files",
    "world.write",
  ),
  "POST /api/install/github/preview": needs("host.files", "world.write"),
  "POST /api/install/github/batch": needs("host.files", "world.write"),
  "POST /api/install/collection": needs("host.files", "world.write"),
  // ── Media ─────────────────────────────────────────────────────
  "POST /api/media": { ...SESSION, probe: { query: `sessionId=${S}` } },
  // Signed URL: the token in the URL is the access, not the host.
  "GET /api/media/:id": PUBLIC,
  "POST /api/media/cleanup": needs("media.cleanup"),
  "GET /api/media/library": needs("media.library"),
  "POST /api/media/library/delete": needs("media.library"),
  // ── Models and settings ───────────────────────────────────────
  "GET /api/health": PUBLIC,
  "GET /api/config/server-settings": PUBLIC,
  "PUT /api/config/server-settings": needs("server.settings"),
  "GET /api/model-db": PUBLIC,
  "GET /api/model-db/search": PUBLIC,
  "GET /api/model-db/lookup": PUBLIC,
  "POST /api/model-db/refresh": needs("model-db.refresh"),
  "GET /api/presets": { ...needs("server.diagnostics"), refusal: "redacted" },
  "GET /api/llm-config": {
    ...needs("server.diagnostics"),
    refusal: "redacted",
  },
  "POST /api/llm-config/reload": needs("host.config"),
  "GET /api/provider-keys": needs("server.diagnostics"),
  "GET /api/ai/protocols": PUBLIC,
  "POST /api/ai/models": needs("model.probe"),
  "POST /api/ai/ping": needs("model.probe"),
  "GET /api/config/info": {
    ...needs("server.diagnostics"),
    refusal: "redacted",
  },
  "GET /api/config/keys": needs("host.config"),
  "PUT /api/config/keys": needs("host.config"),
  "GET /api/config/settings": needs("host.config"),
  "PUT /api/config/settings": needs("host.config"),
  "GET /api/config/proxy": needs("host.config"),
  "PUT /api/config/proxy": needs("host.config"),
  "PUT /api/config/data-root": needs("host.config"),
  "POST /api/config/open-folder": needs("host.config"),
  "GET /api/config/raw": needs("host.files"),
  "GET /api/config/raw/:name": needs("host.files"),
  "PUT /api/config/raw/:name": needs("host.files"),
  "GET /api/app-update/latest": needs("host.config"),
  // ── Local model relay: the browser's own channel ID is the credential,
  // and only a shared host (`credentials.modelRelay`) answers. ─────────
  "GET /api/model-relay/stream": PUBLIC,
  "POST /api/model-relay/requests/:id/head": PUBLIC,
  "POST /api/model-relay/requests/:id/chunk": PUBLIC,
  "POST /api/model-relay/requests/:id/end": PUBLIC,
  "POST /api/model-relay/requests/:id/fail": PUBLIC,
};

/** The code the probe profile answers an action with. */
const codeFor = (action: HostAction) =>
  `denied_${action.replace(/[.-]/g, "_")}`;

/**
 * A profile that refuses every action with a code naming it, whatever token
 * is presented. The session rule stays an owner rule so owners are still
 * checked the way the routes check them.
 */
function closedProfile(): HostProfile {
  const base = deriveHostProfile(readRuntimeEnv({}), {
    storeBackend: "memory",
  });
  const access = Object.fromEntries(
    HOST_ACTIONS.map((action): [HostAction, HostAccessRule] => [
      action,
      {
        kind: action === "session.access" ? "owner" : "closed",
        denial: { status: 403, code: codeFor(action), message: action },
      },
    ]),
  ) as Record<HostAction, HostAccessRule>;
  return { ...base, access, isOperatorToken: () => false };
}

function concretePath(path: string): string {
  return path
    .replace(/^\/api\/sessions\/:id/, `/api/sessions/${S}`)
    .replace(/^\/api\/traces\/:sessionId/, `/api/traces/${S}`)
    .replace(/^\/api\/worlds\/:id/, `/api/worlds/${W}`)
    .replace(/:[A-Za-z]+/g, "probe");
}

let api: ApiBootstrapResult | undefined;
let store: DataStore;
let app: Hono;

beforeAll(async () => {
  const pluginsDir = await mkdtemp(join(tmpdir(), "covel-route-access-"));
  store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createWorld({
    id: W,
    name: "Probe world",
    description: "",
    createdAt: now,
  });
  await store.createSession({
    id: S,
    worldId: W,
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    locale: "en-US",
    activePlugins: [],
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
  const profile = closedProfile();
  api = await bootstrapApi({
    pluginsDir,
    store,
    storeBackend: "memory",
    hostProfile: profile,
    mediaStore: createMemoryMediaStore(),
    llmAdapter: { chat: async () => ({}) } as never,
  });
  const ai = createAiStack();
  // As app.ts assembles it: the profile first, then every route module.
  app = new Hono();
  app.use("*", hostProfileMiddleware(profile));
  mountApiRoutes(app, { api, ai, store, apiKeys: {} });
}, 60_000);

afterAll(async () => {
  await closeTestApi(api);
  await store.close();
});

describe("route access table", () => {
  it("lists exactly the routes the server serves", () => {
    const served = new Set(
      app.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    );
    const listed = new Set(Object.keys(ROUTES));
    const missing = [...served].filter((route) => !listed.has(route));
    const stale = [...listed].filter((route) => !served.has(route));
    expect(
      missing,
      "New routes: add each to ROUTES with the host actions it needs",
    ).toEqual([]);
    expect(stale, "Routes no longer served: remove them from ROUTES").toEqual(
      [],
    );
  });

  const probed = Object.entries(ROUTES).filter(
    ([, access]) => access.needs.length > 0 && !access.onlyWhen,
  );

  it.each(probed)(
    "%s is refused by the host profile",
    async (route, access) => {
      const [method, path] = route.split(" ") as [string, string];
      const first = access.needs[0]!;
      const query = access.probe?.query ? `?${access.probe.query}` : "";
      const body = access.probe?.body;
      const res = await app.request(`${concretePath(path)}${query}`, {
        method,
        ...(method === "GET" || method === "HEAD"
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body ?? {}),
            }),
      });
      if (access.refusal === "empty-list") {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ items: [] });
        return;
      }
      if (access.refusal === "redacted") {
        expect(res.status).toBe(200);
        return;
      }
      expect(res.status, await res.clone().text()).toBe(403);
      expect(await res.json()).toMatchObject({ code: codeFor(first) });
    },
  );
});

describe("deployment variables", () => {
  const ROOT = join(import.meta.dirname, "../../../..");
  const DEPLOYMENT_FIELDS =
    /\.(deploymentTier|desktopRestToken|installApiEnabled|mediaCleanupEnabled)\b/;
  const DEPLOYMENT_NAMES =
    /["'`](DEPLOYMENT_TIER|COVEL_DESKTOP_REST_TOKEN|COVEL_INSTALL_API_ENABLED|COVEL_MEDIA_CLEANUP_ENABLED|COVEL_ALLOWED_HOSTS)["'`]/;

  async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
      else if (/\.tsx?$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  /** Lines that read a deployment setting, comments left out. */
  async function readers(dirs: string[], allowed: (file: string) => boolean) {
    const found: string[] = [];
    for (const dir of dirs) {
      for (const file of await sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (allowed(rel)) continue;
        const lines = (await readFile(file, "utf8")).split("\n");
        for (const [index, line] of lines.entries()) {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*")) continue;
          if (DEPLOYMENT_FIELDS.test(line) || DEPLOYMENT_NAMES.test(line)) {
            found.push(`${rel}:${index + 1}: ${code}`);
          }
        }
      }
    }
    return found;
  }

  it("are read only by the host profile in the server", async () => {
    expect(
      await readers(
        ["apps/server/src"],
        (file) => file === "apps/server/src/host-profile.ts",
      ),
    ).toEqual([]);
  });

  it("are not read by the core packages", async () => {
    const packages = (await readdir(join(ROOT, "packages"))).map(
      (name) => `packages/${name}/src`,
    );
    const existing: string[] = [];
    for (const dir of packages) {
      try {
        await readdir(join(ROOT, dir));
        existing.push(dir);
      } catch {
        // A package without src/.
      }
    }
    // shared keeps the registry entries and the parser.
    expect(
      await readers(existing, (file) =>
        file.startsWith("packages/shared/src/env/"),
      ),
    ).toEqual([]);
  });
});
