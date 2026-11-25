import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createProviderSourceHost } from "../../src/routes/api/bootstrap/provider-sources.js";
import type { PermissionService } from "../../src/trust/permission-service.js";

function createTestHost(opts?: {
  allowProviderSource?: () => boolean;
  accounts?: "one" | "many";
}) {
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  const allow = opts?.allowProviderSource ?? (() => true);
  registry.register({
    id: "test-src",
    source: "builtin",
    status: "registered",
    summary: {
      id: "test-src",
      name: "test-src",
      description: "Test source plugin",
      kind: "plugin",
      runtimeCount: 0,
    },
    packageManifest: {
      manifest: {
        name: "test-src",
        pluginId: "test-src",
        version: "1.0.0",
        description: "Test source plugin",
        kind: "plugin",
      },
      plugin: {
        id: "test-src",
        kind: "plugin",
        version: "1.0.0",
        description: "Test source plugin",
        scope: "instance",
        permissions: {
          http: [{ origin: "https://api.example.test", methods: ["POST"] }],
        },
        contributes: {
          providerSources: [
            {
              id: "sub",
              label: "Test Sub",
              baseUrl: "https://api.example.test/v1",
              accounts: opts?.accounts ?? "many",
              modes: ["text"],
            },
          ],
        },
      },
      sourcePath: "test",
      promptTemplate: "",
      rawFrontmatter: {},
    },
  });

  const permissionService = {
    snapshot: () => ({
      capabilities: {
        "plugin.providerSource": allow() ? "allow" : "deny",
        "plugin.instanceScope": "allow",
        "net.httpDeclared": "allow",
      },
    }),
    evaluateCapabilityForPlugin: (key: string) => ({
      effective:
        key === "plugin.providerSource"
          ? allow()
            ? "allow"
            : "deny"
          : "allow",
      lockedBy: allow() ? undefined : "policy",
      ceiling: "allow",
    }),
    isCapabilityAllowedForPlugin: (key: string) =>
      key === "plugin.providerSource" ? allow() : true,
  } as unknown as PermissionService;

  const host = createProviderSourceHost({
    registry,
    store,
    getPermissionService: () => permissionService,
    getTrustedSources: () => undefined,
    getInstancePlugins: () =>
      ({
        isActivated: () => true,
        activate: async () => {},
        listInstancePlugins: () => [],
        activateForEvent: async () => {},
      }) as never,
  });

  return { host };
}

describe("ProviderSourceHost hardening", () => {
  it("rejects forbidden hop-by-hop, Host, Proxy-*, and CR/LF headers returned by resolve()", async () => {
    const { host } = createTestHost();
    let headersToReturn: Record<string, string> = {};
    host.register("test-src", {
      id: "sub",
      async resolve() {
        return { headers: headersToReturn };
      },
    });

    const badHeaderCases: ReadonlyArray<Record<string, string>> = [
      { Host: "evil.example.com" },
      { "Transfer-Encoding": "chunked" },
      { "Content-Length": "123" },
      { "Proxy-Authorization": "Basic secret" },
      { "X-Custom": "ok\r\nInjected: yes" },
      { "Bad Header": "value" },
    ];
    for (const badHeaders of badHeaderCases) {
      headersToReturn = badHeaders;
      await expect(
        host.resolver.resolve({
          sourceId: "test-src/sub",
          mode: "text",
          model: "m1",
        }),
      ).rejects.toThrow(/forbidden header|invalid header/i);
    }

    headersToReturn = { Authorization: "Bearer valid-tok" };
    await expect(
      host.resolver.resolve({
        sourceId: "test-src/sub",
        mode: "text",
        model: "m1",
      }),
    ).resolves.toMatchObject({
      headers: { Authorization: "Bearer valid-tok" },
    });
  });

  it("checks live permission gate on listReadyAccounts cache hit", async () => {
    let allowed = true;
    const { host } = createTestHost({
      allowProviderSource: () => allowed,
      accounts: "many",
    });
    host.register("test-src", {
      id: "sub",
      async listAccounts() {
        return [
          {
            id: "acct-default",
            label: "Default",
            status: "ready",
            isDefault: true,
          },
          { id: "acct-backup", label: "Backup", status: "ready" },
        ];
      },
      async resolve() {
        return { headers: { Authorization: "Bearer tok" } };
      },
    });

    expect(await host.resolver.listReadyAccounts?.("test-src/sub")).toEqual([
      "acct-default",
      "acct-backup",
    ]);

    // Revoking permission immediately stops cached accounts from being returned.
    allowed = false;
    expect(await host.resolver.listReadyAccounts?.("test-src/sub")).toEqual([]);
  });

  it("coalesces omitted accountId with cached default account and fences stale refreshes across invalidatePlugin", async () => {
    const { host } = createTestHost({ accounts: "many" });
    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    let signalRefreshStarted: (() => void) | undefined;
    let refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    let failRefresh = false;

    host.register("test-src", {
      id: "sub",
      async listAccounts() {
        return [
          {
            id: "acct-default",
            label: "Default",
            status: "ready",
            isDefault: true,
          },
        ];
      },
      async resolve() {
        return {
          accountId: "acct-default",
          headers: { Authorization: "Bearer tok-1" },
          credentialGeneration: 1,
        };
      },
      async refresh() {
        refreshCalls += 1;
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
          signalRefreshStarted?.();
        });
        if (failRefresh) throw new Error("stale failure");
        return {
          accountId: "acct-default",
          headers: { Authorization: "Bearer tok-2" },
          credentialGeneration: 2,
        };
      },
    });

    // Populate statusCache with default account "acct-default".
    await host.refreshPluginStatus("test-src");

    // Concurrent refresh with omitted accountId vs explicit "acct-default"
    // must coalesce into a single refresh() invocation.
    const r1 = host.resolver.refresh!({
      sourceId: "test-src/sub",
      mode: "text",
      model: "m1",
      failedGeneration: 1,
      statusCode: 401,
    });
    const r2 = host.resolver.refresh!({
      sourceId: "test-src/sub",
      accountId: "acct-default",
      mode: "text",
      model: "m1",
      failedGeneration: 1,
      statusCode: 401,
    });
    await refreshStarted;
    releaseRefresh?.();
    const [a1, a2] = await Promise.all([r1, r2]);
    expect(refreshCalls).toBe(1);
    expect(a1?.headers).toEqual({ Authorization: "Bearer tok-2" });
    expect(a2?.headers).toEqual({ Authorization: "Bearer tok-2" });

    // Now start a refresh that will fail, invalidate the plugin mid-flight,
    // refresh clean status, then let the stale refresh reject: it must NOT
    // poison statusCache back to needs_reauth.
    failRefresh = true;
    refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const staleRefresh = host.resolver.refresh!({
      sourceId: "test-src/sub",
      accountId: "acct-default",
      mode: "text",
      model: "m1",
      failedGeneration: 2,
      statusCode: 401,
    });
    await refreshStarted;
    host.invalidatePlugin("test-src");
    await host.refreshPluginStatus("test-src");
    expect(host.resolver.inspectSync("test-src/sub")).toMatchObject({
      ready: true,
    });

    releaseRefresh?.();
    expect(await staleRefresh).toBeNull();
    expect(host.resolver.inspectSync("test-src/sub")).toMatchObject({
      ready: true,
    });
  });
});
