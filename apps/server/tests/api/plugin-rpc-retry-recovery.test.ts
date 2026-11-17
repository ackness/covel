/**
 * A plugin RPC that names a retry source is not a recovery of the source's
 * failed task: it runs without the source's event, so neither its success
 * nor its failure changes what an action recovery may do. Real action and
 * plugin-rpc routes, executor, commit and store, with the bundled
 * scene-stage resolver as the event-triggered task.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const project = path.resolve(import.meta.dirname, "../../../..");
const resolver = "scene-stage/resolver";
const sessionId = "rpc-recovery-session";

/** A plugin whose one runtime emits a scene change every turn. */
async function writePublisher(dir: string) {
  await mkdir(path.join(dir, "runtimes", "emit"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "publisher", type: "module" }),
  );
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    `---
id: publisher
kind: plugin
version: 1.0.0
description: Emits a scene change
---
`,
  );
  await writeFile(
    path.join(dir, "runtimes", "emit", "RUNTIME.md"),
    `---
description: Emits a scene change
schedule:
  stage: post-turn
  trigger:
    type: auto
function: {}
---
`,
  );
  await writeFile(
    path.join(dir, "runtimes", "emit", "handler.js"),
    `export default async () => ({
  outcome: "success",
  value: {},
  effects: {
    events: [{ topic: "scene.set", data: { location: "Library", timeOfDay: "day" } }],
  },
});
`,
  );
}

describe("plugin RPC against a retry source", () => {
  let root: string | undefined;
  let boot: ApiBootstrapResult | undefined;
  let store:
    | ReturnType<typeof createMemoryStore>
    | ReturnType<typeof createSqliteStore>
    | undefined;

  afterEach(async () => {
    await closeTestApi(boot);
    boot = undefined;
    await store?.close();
    store = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each(["memory", "sqlite"] as const)(
    "leaves an event task failed for an action recovery after an RPC without the event succeeded and then failed (%s)",
    async (backend) => {
      root = await mkdtemp(path.join(tmpdir(), "covel-rpc-recovery-"));
      const plugins = path.join(root, "plugins");
      await cp(
        path.join(project, "plugins", "scene-stage"),
        path.join(plugins, "scene-stage"),
        {
          recursive: true,
          filter: (source) => !source.includes("node_modules"),
        },
      );
      await writePublisher(path.join(plugins, "publisher"));
      const db =
        backend === "sqlite"
          ? createSqliteStore(path.join(root, "session.sqlite"))
          : createMemoryStore();
      store = db;
      const now = new Date().toISOString();
      await db.createSession({
        id: sessionId,
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        activePlugins: ["publisher", "scene-stage"],
        completedPlayerTurns: 1,
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        metadata: {
          approvalScopeNonce: "approval",
          sessionIncarnationNonce: "incarnation",
        },
        createdAt: now,
        updatedAt: now,
      });
      let failResolver = true;
      let hookRegistered = false;
      boot = await bootstrapApi({
        pluginsDir: plugins,
        worldsDirs: [],
        covelHome: path.join(root, "home"),
        store: db,
        storeBackend: backend,
        llmAdapter: {
          generate: async () => {
            throw new Error("unexpected model call");
          },
        },
        perRequestMiddleware: [
          async (context, next) => {
            if (!hookRegistered) {
              const hooks = context.get("hookPipeline");
              if (!hooks) throw new Error("Missing hook pipeline");
              hooks.register<{ result: RuntimeResult }>({
                id: "temporary-scene-failure",
                pluginId: "scene-stage",
                event: "PostRuntime",
                handler: async (_context, { result }) =>
                  failResolver && result.runtimeId === resolver
                    ? {
                        action: "continue",
                        replace: {
                          result: {
                            ...result,
                            status: "failed",
                            error: "Temporary scene failure",
                          },
                        },
                      }
                    : { action: "continue" },
              });
              hookRegistered = true;
            }
            await next();
          },
        ],
      });
      const post = async (endpoint: string, body: unknown) => {
        const response = await boot!.app.request(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        return text;
      };
      const latest = async () => {
        const row = (await db.listTurnResults(sessionId)).at(-1)!;
        const result = (row.runtimeResults as RuntimeResult[]).find(
          ({ runtimeId }) => runtimeId === resolver,
        );
        return { row, result };
      };
      const stage = async () =>
        (await db.getPluginData(sessionId, "scene-stage", "stage", "current"))
          ?.value;

      await post("/api/actions", {
        type: "submit_actions",
        sessionId,
        requestId: "source",
        payload: { actions: [{ kind: "say", text: "Go to the library" }] },
      });
      const source = await latest();
      expect(source.row.commitStatus).toBe("committed");
      expect(source.result).toMatchObject({
        status: "failed",
        trigger: { topic: "scene.set" },
      });
      expect(await stage()).toBeUndefined();

      const rpc = {
        kind: "runtime",
        pluginId: "scene-stage",
        runtimeId: resolver,
        payload: {},
        retryFromTurnId: source.row.turnId,
      };
      // Without the event the resolver has nothing to do, and says so as a
      // success; then a second RPC fails. Both commit against the source.
      failResolver = false;
      await post(`/api/sessions/${sessionId}/plugin-rpc`, rpc);
      const noop = await latest();
      expect(noop.row).toMatchObject({
        commitStatus: "committed",
        retryScope: { sourceTurnId: source.row.turnId },
      });
      expect(noop.row.retryScope?.recovery).toBeUndefined();
      expect(noop.result).toMatchObject({
        status: "success",
        output: { skipped: true },
      });
      expect(noop.result?.trigger).toBeUndefined();
      failResolver = true;
      await post(`/api/sessions/${sessionId}/plugin-rpc`, rpc);
      expect((await latest()).result?.status).toBe("failed");
      expect(await stage()).toBeUndefined();

      failResolver = false;
      const recovery = await post("/api/actions", {
        type: "retry_runtime",
        sessionId,
        requestId: "recovery",
        payload: { runtimeId: resolver, retryFromTurnId: source.row.turnId },
      });
      expect(recovery).not.toContain("retry_target_not_failed");
      const recovered = await latest();
      expect(recovered.row).toMatchObject({
        commitStatus: "committed",
        retryScope: { sourceTurnId: source.row.turnId, recovery: true },
      });
      expect(recovered.result).toMatchObject({
        status: "success",
        trigger: source.result!.trigger,
      });
      expect(await stage()).toMatchObject({ name: "Library" });
    },
  );
});
