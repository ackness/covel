// @vitest-environment jsdom
import React from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import { App } from "../src/App.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

const originalFetch = globalThis.fetch;

function createSseResponse(events: unknown[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const [index, event] of events.entries()) {
        controller.enqueue(
          new TextEncoder().encode(
            `id: ${index + 1}\nevent: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
          )
        );
      }
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream"
    }
  });
}

describe("App", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/worlds") && (!init || init.method === undefined)) {
        return Response.json([
          {
            id: "world_01",
            name: "Northreach",
            description: "Frozen frontier",
            createdAt: "2026-03-24T12:00:00.000Z"
          }
        ]);
      }

      if (url.endsWith("/packages")) {
        return Response.json([
          {
            name: "core-guide",
            enabled: true
          }
        ]);
      }

      if (url.includes("/sessions?worldId=world_01")) {
        return Response.json([
          {
            id: "session_01",
            worldId: "world_01",
            status: "active",
            createdAt: "2026-03-24T12:00:01.000Z"
          }
        ]);
      }

      if (url.endsWith("/sessions/session_01/messages")) {
        return Response.json([
          {
            id: "msg_01",
            role: "assistant",
            content: "The gatehouse is silent.",
            createdAt: "2026-03-24T12:00:02.000Z"
          }
        ]);
      }

      if (url.includes("/archives?sessionId=session_01")) {
        return Response.json([]);
      }

      if (url.endsWith("/worlds") && init?.method === "POST") {
        return Response.json({
          id: "world_02",
          name: "Shattercoast",
          description: "Storm-lashed islands",
          createdAt: "2026-03-24T12:10:00.000Z"
        }, { status: 201 });
      }

      if (url.endsWith("/actions")) {
        const body = JSON.parse(String(init?.body));
        if (body.type === "send_message") {
          return createSseResponse([
            {
              type: "message.delta",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: "session_01",
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 1,
              timestamp: "2026-03-24T12:00:00.000Z",
              payload: {
                messageId: "msg_02",
                delta: "The snow parts."
              }
            },
            {
              type: "message.completed",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: "session_01",
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 2,
              timestamp: "2026-03-24T12:00:01.000Z",
              payload: {
                messageId: "msg_02",
                content: "The snow parts."
              }
            },
            {
              type: "block.emitted",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: "session_01",
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 3,
              timestamp: "2026-03-24T12:00:01.100Z",
              payload: {
                block: {
                  id: "blk_01",
                  type: "choices",
                  version: "1.0",
                  meta: {
                    package: "core-guide",
                    requestId: "req_01",
                    traceId: "tr_01",
                    sessionId: "session_01",
                    turnId: "turn_01"
                  },
                  interaction: {
                    requiresResponse: true,
                    responseSchema: "schemas/blocks/choices.response.json",
                    submitAs: "block_response",
                    resumePolicy: "resume_current_flow"
                  },
                  data: {
                    title: "Choose",
                    options: [
                      { id: "opt_a", label: "Advance" },
                      { id: "opt_b", label: "Wait" }
                    ]
                  }
                }
              }
            },
            {
              type: "flow.completed",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: "session_01",
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 4,
              timestamp: "2026-03-24T12:00:02.000Z",
              payload: {
                turnId: "turn_01"
              }
            }
          ]);
        }

        return createSseResponse([
          {
            type: "message.completed",
            requestId: "req_02",
            traceId: "tr_02",
            sessionId: "session_01",
            turnId: "turn_02",
            flowId: "flow_01",
            seq: 1,
            timestamp: "2026-03-24T12:00:03.000Z",
            payload: {
              messageId: "msg_03",
              content: "You advance into the drift."
            }
          },
          {
            type: "flow.completed",
            requestId: "req_02",
            traceId: "tr_02",
            sessionId: "session_01",
            turnId: "turn_02",
            flowId: "flow_01",
            seq: 2,
            timestamp: "2026-03-24T12:00:04.000Z",
            payload: {
              turnId: "turn_02"
            }
          }
        ]);
      }

      if (url.endsWith("/archives") && init?.method === "POST") {
        return Response.json({
          version: {
            id: "archive_01",
            sessionId: "session_01",
            turnCutoff: 2,
            createdAt: "2026-03-24T12:20:00.000Z"
          }
        }, { status: 201 });
      }

      if (url.includes("/archives?sessionId=session_01")) {
        return Response.json([
          {
            id: "archive_01",
            sessionId: "session_01",
            turnCutoff: 2,
            createdAt: "2026-03-24T12:20:00.000Z"
          }
        ]);
      }

      if (url.endsWith("/archives/archive_01/restore")) {
        return Response.json({
          session: {
            id: "session_02",
            worldId: "world_01",
            status: "active",
            createdAt: "2026-03-24T12:21:00.000Z"
          }
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders web chrome in Chinese by default and displays session data", async () => {
    renderWithI18n(<App />);

    await screen.findByText("Northreach");
    expect(screen.getByText("世界")).toBeTruthy();
    expect(screen.getByText("扩展包")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("core-guide")).toBeTruthy();
    expect(await screen.findByText("The gatehouse is silent.")).toBeTruthy();
  });

  it("creates a world, sends a message, renders a pending block, and submits the response", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findByText("Northreach");

    await user.type(screen.getByLabelText("世界名称"), "Shattercoast");
    await user.type(screen.getByLabelText("世界描述"), "Storm-lashed islands");
    await user.click(screen.getByRole("button", { name: "创建世界" }));

    await screen.findByText("Shattercoast");

    await user.type(screen.getByLabelText("输入"), "Advance through the drift");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("The snow parts.");
    await screen.findByText("Choose");
    await user.click(screen.getByRole("button", { name: "Advance" }));

    await screen.findByText("You advance into the drift.");
    await waitFor(() => {
      expect(screen.queryByText("Choose")).toBeNull();
    });
  });

  it("creates an archive and restores it as a fork", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findByText("Northreach");

    await user.click(screen.getByRole("button", { name: "创建快照" }));
    await screen.findByText("archive_01");

    await user.click(screen.getByRole("button", { name: "以分支恢复" }));

    await screen.findByText("session_02");
  });

  it("allows switching chrome text to English without translating runtime content", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findByText("Northreach");
    await user.selectOptions(screen.getByLabelText("语言"), "en");

    expect(screen.getByText("Worlds")).toBeTruthy();
    expect(screen.getByText("Packages")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("The gatehouse is silent.")).toBeTruthy();
  });
});
