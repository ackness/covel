// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionRequest, SseEnvelope } from "../../../modules/contracts/src/index.js";
import {
  createSseEnvelope
} from "./helpers/fixtures.js";
import {
  createSseResponse,
  installFetchStub,
  serializeSseEvent
} from "./helpers/fetch-stub.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface ActionDispatcherModule {
  dispatchActionWithSse(input: {
    runtimeBaseUrl: string;
    action: ActionRequest;
    onEnvelope(envelope: SseEnvelope): void | Promise<void>;
    fetchImpl?: typeof fetch;
  }): Promise<void>;
}

const runtimeBaseUrl = "http://runtime.test";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("apps/web action dispatcher", () => {
  it("posts a send_message action and replays the SSE stream into the consumer callback", async () => {
    const { dispatchActionWithSse } = await loadWebModule<ActionDispatcherModule>(
      "actions/action-dispatcher.ts"
    );
    const events = [
      createSseEnvelope("message.delta", 1, {
        messageId: "msg_01",
        role: "assistant",
        delta: "你听见"
      }),
      createSseEnvelope("message.completed", 2, {
        messageId: "msg_01"
      }),
      createSseEnvelope("flow.completed", 3, {
        outcome: "ok"
      })
    ];
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: `${runtimeBaseUrl}/actions`,
        handler: async () =>
          createSseResponse(events.map((event) => serializeSseEvent({
            id: event.seq,
            type: event.type,
            data: event
          })))
      }
    ]);
    const onEnvelope = vi.fn((_envelope: SseEnvelope) => undefined);

    await dispatchActionWithSse({
      runtimeBaseUrl,
      action: {
        requestId: "req_01",
        type: "send_message",
        sessionId: "ses_01",
        payload: {
          content: "继续前进"
        }
      },
      onEnvelope
    });

    const request = fetchStub.calls[0];
    expect(request).toBeDefined();
    expect(request?.headers.get("accept-language")).toBe("zh-CN");
    expect(request?.headers.get("content-type")).toContain("application/json");
    await expect(request?.json()).resolves.toEqual({
      requestId: "req_01",
      type: "send_message",
      sessionId: "ses_01",
      locale: "zh-CN",
      payload: {
        content: "继续前进"
      }
    });
    expect(onEnvelope.mock.calls.map((call) => call[0])).toEqual(events);

    fetchStub.restore();
  });

  it("rejects a stream that never emits a terminal flow event", async () => {
    const { dispatchActionWithSse } = await loadWebModule<ActionDispatcherModule>(
      "actions/action-dispatcher.ts"
    );
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: `${runtimeBaseUrl}/actions`,
        handler: async () =>
          createSseResponse([
            serializeSseEvent({
              id: 1,
              type: "message.delta",
              data: createSseEnvelope("message.delta", 1, {
                messageId: "msg_01",
                role: "assistant",
                delta: "未完成"
              })
            })
          ])
      }
    ]);

    await expect(
      dispatchActionWithSse({
        runtimeBaseUrl,
        action: {
          requestId: "req_02",
          type: "send_message",
          sessionId: "ses_01",
          payload: {
            content: "继续"
          }
        },
        onEnvelope: vi.fn()
      })
    ).rejects.toThrowError(/flow\.completed|flow\.failed/i);

    fetchStub.restore();
  });
});
