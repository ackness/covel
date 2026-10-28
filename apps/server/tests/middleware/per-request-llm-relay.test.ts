// @vitest-environment node
/**
 * The per-request model middleware attaches the browser's model relay only
 * where the host cannot reach the player's network itself, and only for a
 * well-formed channel the request names.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import type { AiStack } from "../../src/ai-setup.js";
import {
  hostProfileMiddleware,
  resolveHostProfile,
} from "../../src/host-profile.js";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { createModelRelayRegistry } from "../../src/model-relay/registry.js";
import { getRequestLlmOptions } from "../../src/request-llm-context.js";

const CHANNEL = "relay-channel-for-tests-0123456789abcdef";

function appFor(
  vars: Record<string, string>,
  storeBackend: "memory" | "sqlite",
) {
  const app = new Hono();
  app.use(
    "*",
    hostProfileMiddleware(
      resolveHostProfile(readRuntimeEnv(vars), { storeBackend }),
    ),
  );
  app.use(
    "*",
    createPerRequestLlmMiddleware({
      ai: { gateway: {} } as unknown as AiStack,
      envApiKeys: {},
      defaultLlmAdapter: {} as LLMAdapter,
      defaultPluginGateway: {} as PluginRuntimeGateway,
      modelRelay: createModelRelayRegistry(),
    }),
  );
  app.get("/probe", (c) =>
    c.json({
      relay: getRequestLlmOptions()?.relay !== undefined,
      overridden: c.get("requestLlmOverridden") === true,
    }),
  );
  return app;
}

const probe = async (app: Hono, channel?: string) =>
  (await (
    await app.request(
      "/probe",
      channel ? { headers: { "X-Model-Relay": channel } } : {},
    )
  ).json()) as { relay: boolean; overridden: boolean };

describe("per-request model relay", () => {
  it("attaches the named channel's relay on a shared host", async () => {
    const app = appFor({ NODE_ENV: "production" }, "memory");
    expect(await probe(app, CHANNEL)).toEqual({
      relay: true,
      overridden: true,
    });
    expect(await probe(app)).toEqual({ relay: false, overridden: false });
    expect(await probe(app, "short")).toEqual({
      relay: false,
      overridden: false,
    });
  });

  it("never attaches one on a personal host", async () => {
    const app = appFor({}, "sqlite");
    expect(await probe(app, CHANNEL)).toEqual({
      relay: false,
      overridden: false,
    });
  });
});
