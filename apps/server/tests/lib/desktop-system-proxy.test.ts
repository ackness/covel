import { describe, expect, it, vi } from "vitest";
import {
  createSystemProxyIpcResolver,
  hasDesktopSystemProxyIpc,
  type SystemProxyIpcClient,
} from "../../src/lib/desktop-system-proxy.js";
import type {
  SystemProxyResolveRequest,
  SystemProxyResolveResponse,
} from "@covel/shared";

function fakeClient() {
  const sent: SystemProxyResolveRequest[] = [];
  let onMessage: (message: unknown) => void = () => undefined;
  let onDisconnect: () => void = () => undefined;
  const client: SystemProxyIpcClient = {
    connected: () => true,
    send: (request, callback) => {
      sent.push(request);
      callback(null);
    },
    subscribe: (message, disconnect) => {
      onMessage = message;
      onDisconnect = disconnect;
      return vi.fn();
    },
  };
  return {
    client,
    sent,
    respond(response: SystemProxyResolveResponse) {
      onMessage(response);
    },
    disconnect() {
      onDisconnect();
    },
  };
}

describe("desktop system proxy resolver", () => {
  it("requires the Electron sidecar capability in addition to Node IPC", () => {
    const send = () => undefined;
    expect(hasDesktopSystemProxyIpc({}, send)).toBe(false);
    expect(
      hasDesktopSystemProxyIpc(
        { COVEL_DESKTOP_SYSTEM_PROXY_IPC: "1" },
        undefined,
      ),
    ).toBe(false);
    expect(
      hasDesktopSystemProxyIpc({ COVEL_DESKTOP_SYSTEM_PROXY_IPC: "1" }, send),
    ).toBe(true);
  });

  it("matches concurrent out-of-order replies by request id", async () => {
    const ipc = fakeClient();
    const resolver = createSystemProxyIpcResolver(ipc.client);
    const first = resolver.resolve("https://first.example/models");
    const second = resolver.resolve("https://second.example/models");

    ipc.respond({
      type: "covel:system-proxy:resolved",
      version: 1,
      requestId: ipc.sent[1]!.requestId,
      result: "DIRECT",
    });
    ipc.respond({
      type: "covel:system-proxy:resolved",
      version: 1,
      requestId: ipc.sent[0]!.requestId,
      result: "PROXY proxy.example:8080",
    });

    await expect(first).resolves.toBe("PROXY proxy.example:8080");
    await expect(second).resolves.toBe("DIRECT");
    resolver.dispose();
  });

  it("rejects pending work on disconnect and timeout", async () => {
    const ipc = fakeClient();
    const resolver = createSystemProxyIpcResolver(ipc.client, 5);
    const disconnected = resolver.resolve("https://first.example/models");
    ipc.disconnect();
    await expect(disconnected).rejects.toThrow(/disconnected/i);
    await expect(
      resolver.resolve("https://second.example/models"),
    ).rejects.toThrow(/timed out/i);
    resolver.dispose();
  });
});
