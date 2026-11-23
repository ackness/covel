import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineExtensionPoint, promptSegmentV1 } from "@covel/shared";
import { channelBridgeV1 } from "@covel/shared/platform";
import {
  PluginExtensionHost,
  kernelExtensionPoints,
} from "../src/plugin-extensions.js";
import {
  PluginServiceRegistry,
  WRITE_SERVICE_MESSAGES,
} from "../src/plugin-services.js";

const customInstancePoint = defineExtensionPoint({
  id: "custom.instance@1",
  scope: "instance",
  mode: "collect",
  onError: "skip",
  timeoutMs: 1000,
  input: z.object({ query: z.string() }),
  output: z.object({ tag: z.string() }),
});

describe("Instance-scope ExtensionPoints & PluginServiceRegistry", () => {
  it("runs scope:instance extension points cleanly and isolates session vs instance scopes", async () => {
    const activeInstancePlugins = new Set(["instance-bridge"]);
    const services = new PluginServiceRegistry({
      list: async () => ["session-only"],
      ensure: async () => {},
      instanceList: async () => [...activeInstancePlugins],
      instanceEnsure: async (pluginId) => {
        activeInstancePlugins.add(pluginId);
      },
      instanceContext: () => ({
        hostId: "host-1",
        instanceData: {
          get: async () => "inst-val",
          list: async () => [{ key: "k1", value: "v1" }],
          set: async () => {},
          delete: async () => false,
        },
      }),
    });

    let seenScope: unknown;
    let seenHostId: unknown;
    let seenInstanceData: unknown;

    services.registerExtension(
      "instance-bridge",
      customInstancePoint,
      {
        point: customInstancePoint.id,
        id: "bridge-1",
      },
      {
        handler: async (input, ctx) => {
          seenScope = ctx.scope;
          seenHostId = ctx.hostId;
          seenInstanceData = await ctx.instanceData?.get("cfg", "k1");
          return { tag: `echo:${input.query}` };
        },
      },
    );

    const host = new PluginExtensionHost(services, [
      ...kernelExtensionPoints,
      customInstancePoint,
    ]);

    const instanceExec = host.createInstanceExecution({
      locale: "en-US",
      signal: AbortSignal.timeout(2000),
    });

    const collectRes = await instanceExec.run(customInstancePoint, {
      query: "ping",
    });
    expect(collectRes).toEqual([{ tag: "echo:ping" }]);
    expect(seenScope).toBe("instance");
    expect(seenHostId).toBe("host-1");
    expect(seenInstanceData).toBe("inst-val");

    // channel.bridge@1 is registered in kernelExtensionPoints with scope: "instance"
    await expect(
      instanceExec.run(channelBridgeV1, {
        phase: "outboundEvent",
        channelId: "telegram",
        sessionId: "sess-1",
        topic: "healthcheck",
        payload: {},
      }),
    ).resolves.toEqual([]);

    // Session-scoped extension point cannot run in instance execution
    await expect(
      instanceExec.run(promptSegmentV1, {
        turn: 1,
        locale: "en-US",
        runtime: { name: "r1", outputKind: "story" },
      } as never),
    ).rejects.toThrow(
      "requires session scope, cannot run in instance execution",
    );

    // Instance-scoped extension point cannot run in session execution
    const sessionExec = host.createExecution({
      sessionId: "sess-1",
      locale: "en-US",
      settings: {},
      signal: AbortSignal.timeout(2000),
      readPluginData: async () => [],
    });
    await expect(
      sessionExec.run(customInstancePoint, { query: "nope" }),
    ).rejects.toThrow(
      "requires instance scope, cannot run in session execution",
    );
  });

  it("provides instanceData & hostId on instance clients and refuses session write services", async () => {
    const services = new PluginServiceRegistry({
      list: async () => [],
      ensure: async () => {},
      instanceList: async () => ["provider-reader"],
      instanceEnsure: async () => {},
      instanceContext: (pluginId) => ({
        hostId: "host-abc",
        instanceData: {
          get: async (ns, key) => `${pluginId}:${ns}:${key}`,
          list: async () => [],
          set: async () => {},
          delete: async () => false,
        },
      }),
    });

    services.register("provider-reader", {
      name: "read-host",
      contract: "test.host@1",
      input: z.object({ key: z.string() }),
      output: z.object({ val: z.unknown(), hostId: z.string().optional() }),
      handler: async (input, ctx) => ({
        val: await ctx.instanceData?.get("ns", input.key),
        hostId: ctx.hostId,
      }),
    });

    services.register("session-writer", {
      name: "write-sess",
      contract: "test.write@1",
      access: "write",
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
    });

    const instanceClient = services.createInstanceClient({
      pluginId: "caller-instance",
      signal: AbortSignal.timeout(2000),
    });

    const readRes = await instanceClient.call({
      pluginId: "provider-reader",
      name: "read-host",
      contract: "test.host@1",
      input: { key: "alpha" },
    });
    expect(readRes).toEqual({
      val: "provider-reader:ns:alpha",
      hostId: "host-abc",
    });

    // Write services cannot be called from an instance-scoped caller
    await expect(
      instanceClient.call({
        pluginId: "session-writer",
        name: "write-sess",
        contract: "test.write@1",
        input: {},
      }),
    ).rejects.toThrow(WRITE_SERVICE_MESSAGES.noStage);
  });
});
