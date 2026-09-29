import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { PluginServiceRegistry } from "@covel/runtime";
import { createPluginServiceAdmission } from "../../src/routes/api/bootstrap/plugin-service-admission.js";
import { rotateSessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

async function fixture() {
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  const parsed = parsePluginMd(
    "---\nid: provider\nkind: plugin\ndescription: Provider\n---\n",
    "provider/PLUGIN.md",
  );
  registry.register({
    id: "provider",
    source: "builtin",
    packageManifest: parsed,
    manifests: [],
    summary: {
      id: "provider",
      name: "provider",
      description: "Provider",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    loadedRuntimes: new Map(),
    status: "registered",
  });
  const now = new Date().toISOString();
  await store.createSession({
    id: "session",
    locale: "en",
    status: "active",
    phase: "playing",
    activePlugins: ["provider"],
    completedPlayerTurns: 0,
    setupRuntimes: {},
    metadata: {
      sessionIncarnationNonce: "original",
      approvalScopeNonce: "original",
    },
    createdAt: now,
    updatedAt: now,
  });
  registry.syncSessionActivations("session", ["provider"]);
  const ensurePluginEntry = vi.fn(async () => {});
  const deferred = new Set<string>();
  const getSession = vi.spyOn(store, "getSession");
  const host = createPluginServiceAdmission({
    store,
    registry,
    ensurePluginEntry,
    isEntryRetryDeferred: (pluginId) => deferred.has(pluginId),
  });
  const services = new PluginServiceRegistry(host.admission);
  services.register("provider", {
    name: "read",
    contract: "fixture.read@1",
    input: z.null(),
    output: z.string(),
    handler: () => "old-generation",
  });
  const client = services.createClient({
    sessionId: "session",
    pluginId: "provider",
    signal: new AbortController().signal,
  });
  const call = () =>
    client.call({
      pluginId: "provider",
      name: "read",
      contract: "fixture.read@1",
      input: null,
    });
  return {
    store,
    registry,
    host,
    services,
    ensurePluginEntry,
    deferred,
    getSession,
    call,
  };
}

describe("production plugin service admission", () => {
  it("lists with one session read and skips deferred failed entries", async () => {
    const f = await fixture();
    f.getSession.mockClear();
    expect(await f.host.admission.list("session")).toEqual(["provider"]);
    expect(f.getSession).toHaveBeenCalledTimes(1);

    f.deferred.add("provider");
    f.ensurePluginEntry.mockClear();
    expect(await f.host.admission.list("session")).toEqual([]);
    expect(f.ensurePluginEntry).not.toHaveBeenCalled();
    // Explicit calls still attempt activation.
    await expect(f.call()).resolves.toBe("old-generation");
    expect(f.ensurePluginEntry).toHaveBeenCalled();
  });

  it("retains an old execution's service graph after reload replans the live session", async () => {
    const f = await fixture();
    const authority = await f.host.capture("session");
    await f.registry.withSnapshot(() =>
      authority.run(() =>
        f.services.withSnapshot(async () => {
          await f.store.updateSession("session", { activePlugins: [] });
          f.registry.syncSessionActivations("session", []);
          expect(await f.host.admission.list("session")).toEqual(["provider"]);
          await expect(f.call()).resolves.toBe("old-generation");
        }),
      ),
    );
    expect(await f.host.admission.list("session")).toEqual([]);
    await expect(f.call()).rejects.toThrow("Plugin is not active");
  });

  it.each(["disable", "replacement", "grant"])(
    "still rejects live %s while an old service graph is captured",
    async (change) => {
      const f = await fixture();
      const authority = await f.host.capture("session");
      await f.registry.withSnapshot(() =>
        authority.run(() =>
          f.services.withSnapshot(async () => {
            const session = (await f.store.getSession("session"))!;
            if (change === "disable") {
              await f.store.updateSession("session", {
                activePlugins: [],
                metadata: rotateSessionApprovalScope(session, "provider"),
              });
              f.registry.syncSessionActivations("session", []);
            } else if (change === "replacement") {
              await f.store.updateSession("session", {
                metadata: {
                  ...session.metadata,
                  sessionIncarnationNonce: "replacement",
                },
              });
            } else {
              f.ensurePluginEntry.mockRejectedValue(
                new Error("Server-code approval revoked"),
              );
            }
            await expect(f.call()).rejects.toThrow(/revoked/);
            expect(await f.host.admission.list("session")).toEqual([]);
          }),
        ),
      );
    },
  );
});
