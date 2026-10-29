/**
 * A community sub-agent provider can run inside any execution of the session,
 * so every preflight admits it: an ordinary action, a retry of named
 * runtimes and a resumed runtime all ask for its grants before they start.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { PluginRegistryEntry } from "@covel/plugin-loader";
import type { RuntimeManifest, ValidatedActionRequest } from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import {
  preflightActionApprovals,
  preflightRuntimeApprovals,
} from "../../src/routes/api/actions/approval-preflight.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

const timestamp = "2026-10-29T00:00:00.000Z";

const session: SessionRecord = {
  id: "sess-preflight",
  worldId: "cloudmere",
  status: "active",
  phase: "playing",
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  metadata: {
    approvalScopeNonce: "scope-nonce",
    sessionIncarnationNonce: "incarnation-nonce",
  },
  locale: "en-US",
  activePlugins: ["narrator", "actor-pkg"],
  completedPlayerTurns: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function entry(
  manifest: RuntimeManifest,
  source: PluginRegistryEntry["source"],
): PluginRegistryEntry {
  return {
    id: manifest.pluginId,
    summary: {
      id: manifest.pluginId,
      kind: "plugin",
      description: manifest.pluginId,
    },
    manifests: [
      {
        runtime: { type: manifest.runtimeType ?? "agent" },
        manifest,
        promptTemplate: "",
        rawFrontmatter: {},
      },
    ],
    loadedRuntimes: new Map(),
    status: "registered",
    source,
  } as unknown as PluginRegistryEntry;
}

const narrator: RuntimeManifest = {
  name: "narrator/tell",
  pluginId: "narrator",
  description: "narrator",
  runtimeType: "agent",
  outputKind: "story",
  stage: "narrative",
  trigger: { type: "auto" },
};
const guard: RuntimeManifest = {
  name: "actor-pkg/guard",
  pluginId: "actor-pkg",
  description: "guard",
  runtimeType: "agent",
  outputKind: "system",
  subagentOnly: true,
  trigger: { type: "manual" },
  outputContract: "test-actor@1",
};

function setup(): { app: Hono; gate: RpcApprovalGate } {
  const registry: PluginRegistry = createPluginRegistry();
  registry.register(entry(narrator, "builtin"));
  registry.register(entry(guard, "community"));
  const gate = createRpcApprovalGate();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginRegistry", registry);
    c.set("rpcApprovalGate", gate);
    await next();
  });
  const respond = (response: Response | undefined) =>
    response ?? Response.json({ ok: true });
  app.post("/retry", async (c) =>
    respond(
      await preflightActionApprovals(c, session, {
        type: "retry_runtime",
        payload: { runtimeId: narrator.name },
      } as ValidatedActionRequest),
    ),
  );
  app.post("/resume", async (c) =>
    respond(await preflightRuntimeApprovals(c, session, [narrator.name])),
  );
  return { app, gate };
}

function grant(gate: RpcApprovalGate, approvalId: string) {
  return gate.decide(
    {
      approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    },
    sessionApprovalScope(session, guard.pluginId),
  );
}

describe("sub-agent provider admission", () => {
  it.each(["/retry", "/resume"])(
    "%s asks for both grants of a community provider before it starts",
    async (path) => {
      const { app, gate } = setup();
      for (const action of [
        "covel:plugin-server-code",
        `runtime:${guard.name}`,
      ]) {
        const response = await app.request(path, { method: "POST" });
        expect(response.status).toBe(202);
        const body = (await response.json()) as {
          status: string;
          approvalId: string;
          pending?: { action?: string };
        };
        expect(body.status).toBe("approval-required");
        expect(body.pending?.action).toBe(action);
        expect(grant(gate, body.approvalId).ok).toBe(true);
      }
      const admitted = await app.request(path, { method: "POST" });
      expect(admitted.status).toBe(200);
    },
  );
});
