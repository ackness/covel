import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import type { RuntimeManifest } from "@covel/shared";
import { createGatewayAdapter } from "../src/llm/gateway-llm-adapter.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";

afterEach(() => vi.unstubAllGlobals());

describe.each(["generate", "stream"] as const)(
  "%s HTTP authentication failure",
  (mode) => {
    it("records auth and reports one failed call without claiming retries were exhausted", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("Authentication Fails (governor)", { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const llm = createGatewayAdapter(
        createGateway({
          providerRegistry: createProviderRegistry({
            providerDefaults: {
              fixture: { baseUrl: "https://fixture.example/v1" },
            },
          }),
          presetRegistry: createPresetRegistry({
            profiles: [],
            presets: [
              {
                id: "fixture",
                name: "Fixture",
                provider: "fixture",
                model: "fixture-model",
                tier: "medium",
                supportedModes: ["text", "stream"],
                enabled: true,
                isDefault: true,
              },
            ],
          }),
        }),
      );
      if (mode === "generate") delete llm.stream;
      const manifest: RuntimeManifest = {
        name: "probe/main",
        pluginId: "probe",
        description: "test",
        runtimeType: "agent",
        stage: "narrative",
        outputKind: "story",
        trigger: { type: "auto" },
      };
      const onRuntimeComplete = vi.fn(async () => {});
      const turn = await runTurnPipeline(
        {
          origin: "player",
          sessionId: "session",
          turnId: "turn",
          playerMessage: "Continue",
        },
        [manifest],
        {
          onRuntimeComplete,
          loadRuntime: async () => ({ manifest, promptTemplate: "probe" }),
          llm,
          toolExecutor: { execute: vi.fn(), getToolInfo: () => undefined },
        },
      );
      const failure = {
        status: "failed",
        errorKind: "auth",
        error: expect.stringMatching(
          /LLM call failed after 1 attempt\(s\).*HTTP 401.*Authentication Fails \(governor\)/,
        ),
      };
      expect(turn.runtimeResults[0]).toMatchObject(failure);
      expect(onRuntimeComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(failure),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  },
);
