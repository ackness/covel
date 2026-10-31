import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPluginAt,
  loadPluginDefinition,
  type PluginDefinition,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import {
  createRpcApprovalGate,
  COMMUNITY_SERVER_CODE_ACTION,
} from "@covel/approval";
import { createServerSettings } from "../../src/lib/server-settings.js";
import { createTrustedSourceService } from "../../src/trust/trusted-source-service.js";
import { refreshDeclarativeEligibility } from "../../src/trust/plugin-admission.js";
import { createRuntimeLoader } from "../../src/routes/api/bootstrap/runtime-loader.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

it("requires real grants for cached code-era agents after the live package becomes declarative", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-runtime-proof-"));
  const root = path.join(parent, "probe");
  const store = createMemoryStore();
  try {
    await mkdir(root);
    await writeFile(
      path.join(root, "PLUGIN.md"),
      "---\ndescription: Probe\nruntime:\n  schedule: { stage: pre-turn }\n---\nA small prompt.",
    );
    await writeFile(
      path.join(root, "development.js"),
      "throw new Error('never import unreferenced code');",
    );
    const registry = createPluginRegistry();
    const discovery = {
      ...(await discoverPluginAt(root))!,
      source: "community" as const,
    };
    const definition = await loadPluginDefinition(discovery);
    const discoveries = new Map<string, PluginDiscoveryResult>([
      [discovery.id, discovery],
    ]);
    const manifests = new Map([[discovery.id, definition.manifests]]);
    const publish = (value: PluginDefinition) => {
      manifests.set(discovery.id, value.manifests);
      registry.register({
        ...value,
        id: discovery.id,
        rootPath: root,
        source: "community",
        status: "registered",
        loadedRuntimes: new Map(),
        summary: {
          id: discovery.id,
          name: discovery.id,
          description: value.packageManifest.plugin.description,
          kind: value.packageManifest.plugin.kind,
          runtimeCount: value.manifests.length,
        },
      });
    };
    publish(definition);
    const now = new Date().toISOString();
    const session = {
      id: "proof-session",
      status: "active" as const,
      phase: "playing" as const,
      locale: "en-US",
      activePlugins: [discovery.id],
      metadata: {
        approvalScopeNonce: "scope",
        sessionIncarnationNonce: "incarnation",
      },
      setupRuntimes: {},
      seats: [],
      completedPlayerTurns: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.createSession(session);
    registry.syncSessionActivations(session.id, session.activePlugins);
    const settings = createServerSettings(store, { playerWritable: true });
    await settings.load();
    const trust = createTrustedSourceService({
      settings,
      registry,
      pluginsRoot: parent,
    });
    await trust.verifyAll();
    const gate = createRpcApprovalGate();
    const manifest = definition.manifests[0]!.manifest;
    const scope = sessionApprovalScope(session, discovery.id);
    for (const action of [
      COMMUNITY_SERVER_CODE_ACTION,
      `runtime:${manifest.name}`,
    ]) {
      const pending = gate.evaluate({
        pluginId: discovery.id,
        sessionId: session.id,
        sessionScope: scope,
        action,
        payload: {},
        trustLevel: "community",
        description: "Run the code package",
      });
      if (pending.status !== "pending")
        throw new Error("Expected explicit code/runtime approval");
      expect(
        gate.decide(
          {
            approvalId: pending.approvalId,
            decision: "allow",
            scope: "session",
            decidedAt: now,
          },
          scope,
        ).ok,
      ).toBe(true);
    }
    const loader = createRuntimeLoader({
      pluginRegistry: registry,
      discoveryMap: discoveries,
      manifestCache: manifests,
      store,
      getApprovalGate: () => gate,
      refreshDeclarativeEligibility: (pluginId) =>
        refreshDeclarativeEligibility(trust, pluginId),
    });
    const captured = await loader.capture(session.id);
    expect(
      (
        await captured.run(() =>
          loader.loadRuntimeFn(manifest, session.locale, session.id),
        )
      )?.executionMode,
    ).toBe("code");
    await rm(path.join(root, "development.js"));
    const next = await loadPluginDefinition(discovery);
    publish(next);
    await trust.verifyAll();
    expect(trust.isDeclarative(discovery.id)).toBe(true);
    // Independent grants may still authorize the old frozen material.
    expect(
      (
        await captured.run(() =>
          loader.loadRuntimeFn(manifest, session.locale, session.id),
        )
      )?.executionMode,
    ).toBe("code");
    gate.revoke(session.id, discovery.id);
    await expect(
      captured.run(() =>
        loader.loadRuntimeFn(manifest, session.locale, session.id),
      ),
    ).rejects.toThrow("current code and runtime grants");
    const publishGeneration = await loader.prepareGeneration({
      discovery,
      definition: next,
      generation: "fresh-data",
      sessionIds: [],
    });
    publishGeneration();
    expect(
      (
        await loader.loadRuntimeFn(
          next.manifests[0]!.manifest,
          session.locale,
          session.id,
        )
      )?.executionMode,
    ).toBe("declarative");
    expect(
      gate.hasGrant(
        session.id,
        discovery.id,
        COMMUNITY_SERVER_CODE_ACTION,
        scope,
      ),
    ).toBe(false);
  } finally {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
