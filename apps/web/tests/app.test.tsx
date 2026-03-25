// @vitest-environment jsdom
import React from "react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    const worlds = [
      {
        id: "world_01",
        name: "Northreach",
        description: "Frozen frontier",
        createdAt: "2026-03-24T12:00:00.000Z"
      }
    ];
    const sessionsByWorld = new Map<string, Array<{
      id: string;
      worldId: string;
      status: string;
      createdAt: string;
      presetId?: string;
      taskBindings?: Record<string, string>;
    }>>([
      [
        "world_01",
        [
          {
            id: "session_01",
            worldId: "world_01",
            status: "active",
            createdAt: "2026-03-24T12:00:01.000Z",
            taskBindings: {
              "story.narration": "default-story"
            }
          }
        ]
      ]
    ]);
    const presets = [
      {
        id: "default-story",
        name: "默认剧情",
        provider: "openaiCompatible",
        model: "qwen3.5-flash",
        enabled: true,
        isDefault: true,
        scope: "global"
      },
      {
        id: "fallback-lab",
        name: "高速回退",
        provider: "openaiCompatible",
        model: "qwen3.5-35b-a3b",
        enabled: true,
        isDefault: false,
        scope: "global"
      }
    ];
    const messagesBySession = new Map<string, Array<{
      id: string;
      role: "assistant" | "user";
      content: string;
      createdAt: string;
    }>>([
      [
        "session_01",
        [
          {
            id: "msg_01",
            role: "assistant",
            content: "The gatehouse is silent.",
            createdAt: "2026-03-24T12:00:02.000Z"
          }
        ]
      ]
    ]);
    const archivesBySession = new Map<string, Array<{
      id: string;
      sessionId: string;
      turnCutoff: number;
      createdAt: string;
    }>>([
      ["session_01", []]
    ]);
    const tracesById = new Map<string, Array<{
      traceId: string;
      component: string;
      eventType: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>>();
    let worldCounter = 1;
    let sessionCounter = 1;
    let messageCounter = 1;
    let archiveCounter = 0;

    globalThis.fetch = vi.fn(async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input.toString();
      const url = new URL(rawUrl, "http://runtime.local");

      if (url.pathname === "/worlds" && (!init || init.method === undefined)) {
        return Response.json(worlds);
      }

      if (url.pathname === "/packages") {
        return Response.json([
          {
            name: "core-guide",
            enabled: true
          }
        ]);
      }

      if (url.pathname === "/presets") {
        return Response.json(presets);
      }

      if (url.pathname === "/sessions" && (!init || init.method === undefined)) {
        return Response.json(sessionsByWorld.get(url.searchParams.get("worldId") ?? "") ?? []);
      }

      if (url.pathname === "/sessions" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { worldId?: string; presetId?: string; taskBindings?: Record<string, string> };
        sessionCounter += 1;
        const session = {
          id: `session_${String(sessionCounter).padStart(2, "0")}`,
          worldId: String(body.worldId ?? ""),
          status: "active",
          createdAt: "2026-03-24T12:11:00.000Z",
          taskBindings: body.taskBindings ?? {
            "story.narration": body.presetId ?? "default-story"
          }
        };
        const currentSessions = sessionsByWorld.get(session.worldId) ?? [];
        sessionsByWorld.set(session.worldId, [...currentSessions, session]);
        messagesBySession.set(session.id, []);
        archivesBySession.set(session.id, []);
        return Response.json(session, { status: 201 });
      }

      if (/^\/sessions\/[^/]+$/.test(url.pathname) && init?.method === "PATCH") {
        const sessionId = url.pathname.split("/")[2] ?? "";
        const body = JSON.parse(String(init.body)) as { presetId?: string; taskBindings?: Record<string, string> };
        for (const [worldId, sessions] of sessionsByWorld.entries()) {
          const updatedSessions = sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  taskBindings: body.taskBindings ?? session.taskBindings ?? (
                    body.presetId
                      ? {
                          "story.narration": body.presetId
                        }
                      : undefined
                  )
                }
              : session
          );
          sessionsByWorld.set(worldId, updatedSessions);
        }

        const updatedSession = [...sessionsByWorld.values()].flat().find((session) => session.id === sessionId);
        return Response.json(updatedSession ?? null);
      }

      if (/^\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[2] ?? "";
        return Response.json(messagesBySession.get(sessionId) ?? []);
      }

      if (url.pathname === "/archives" && (!init || init.method === undefined)) {
        return Response.json(archivesBySession.get(url.searchParams.get("sessionId") ?? "") ?? []);
      }

      if (url.pathname === "/traces") {
        return Response.json(tracesById.get(url.searchParams.get("traceId") ?? "") ?? []);
      }

      if (url.pathname === "/worlds" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name?: string; description?: string };
        worldCounter += 1;
        const world = {
          id: `world_${String(worldCounter).padStart(2, "0")}`,
          name: String(body.name ?? ""),
          description: String(body.description ?? ""),
          createdAt: "2026-03-24T12:10:00.000Z"
        };
        worlds.push(world);
        sessionsByWorld.set(world.id, []);
        return Response.json(world, { status: 201 });
      }

      if (url.pathname === "/actions") {
        const body = JSON.parse(String(init?.body)) as {
          type: string;
          sessionId: string;
          payload: {
            content?: string;
            response?: {
              selected?: string;
            };
          };
        };
        if (body.type === "send_message") {
          const userMessage = {
            id: `msg_${String(++messageCounter).padStart(2, "0")}`,
            role: "user" as const,
            content: String(body.payload.content ?? ""),
            createdAt: "2026-03-24T12:00:02.500Z"
          };
          const assistantMessage = {
            id: `msg_${String(++messageCounter).padStart(2, "0")}`,
            role: "assistant" as const,
            content: "The snow parts.",
            createdAt: "2026-03-24T12:00:03.000Z"
          };
          messagesBySession.set(body.sessionId, [
            ...(messagesBySession.get(body.sessionId) ?? []),
            userMessage,
            assistantMessage
          ]);
          tracesById.set("tr_01", [
            {
              traceId: "tr_01",
              component: "model-gateway",
              eventType: "model.completed",
              payload: {
                model: "demo"
              },
              createdAt: "2026-03-24T12:00:03.000Z"
            }
          ]);
          return createSseResponse([
            {
              type: "message.delta",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: body.sessionId,
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 1,
              timestamp: "2026-03-24T12:00:00.000Z",
              payload: {
                messageId: assistantMessage.id,
                delta: "The snow parts."
              }
            },
            {
              type: "message.completed",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: body.sessionId,
              turnId: "turn_01",
              flowId: "flow_01",
              seq: 2,
              timestamp: "2026-03-24T12:00:01.000Z",
              payload: {
                messageId: assistantMessage.id,
                content: "The snow parts."
              }
            },
            {
              type: "block.emitted",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: body.sessionId,
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
                    sessionId: body.sessionId,
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
              sessionId: body.sessionId,
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

        const resumedMessage = {
          id: `msg_${String(++messageCounter).padStart(2, "0")}`,
          role: "assistant" as const,
          content: "You advance into the drift.",
          createdAt: "2026-03-24T12:00:04.000Z"
        };
        messagesBySession.set(body.sessionId, [
          ...(messagesBySession.get(body.sessionId) ?? []),
          resumedMessage
        ]);
        tracesById.set("tr_02", [
          {
            traceId: "tr_02",
            component: "flow-engine",
            eventType: "resume.completed",
            payload: {
              selected: body.payload.response?.selected ?? null
            },
            createdAt: "2026-03-24T12:00:04.000Z"
          }
        ]);
        return createSseResponse([
          {
            type: "message.completed",
            requestId: "req_02",
            traceId: "tr_02",
            sessionId: body.sessionId,
            turnId: "turn_02",
            flowId: "flow_01",
            seq: 1,
            timestamp: "2026-03-24T12:00:03.000Z",
            payload: {
              messageId: resumedMessage.id,
              content: "You advance into the drift."
            }
          },
          {
            type: "flow.completed",
            requestId: "req_02",
            traceId: "tr_02",
            sessionId: body.sessionId,
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

      if (url.pathname === "/archives" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { sessionId?: string; turnCutoff?: number };
        archiveCounter += 1;
        const archive = {
          id: `archive_${String(archiveCounter).padStart(2, "0")}`,
          sessionId: String(body.sessionId ?? ""),
          turnCutoff: Number(body.turnCutoff ?? 0),
          createdAt: "2026-03-24T12:20:00.000Z"
        };
        archivesBySession.set(archive.sessionId, [
          ...(archivesBySession.get(archive.sessionId) ?? []),
          archive
        ]);
        return Response.json({
          version: archive
        }, { status: 201 });
      }

      if (/^\/archives\/[^/]+\/restore$/.test(url.pathname)) {
        const archiveId = url.pathname.split("/")[2] ?? "";
        const originalArchive = [...archivesBySession.values()]
          .flat()
          .find((archive) => archive.id === archiveId);
        const originalSession = originalArchive
          ? [...sessionsByWorld.values()].flat().find((session) => session.id === originalArchive.sessionId)
          : null;
        sessionCounter += 1;
        const restoredSession = {
          id: `session_${String(sessionCounter).padStart(2, "0")}`,
          worldId: originalSession?.worldId ?? "world_01",
          status: "active",
          createdAt: "2026-03-24T12:21:00.000Z"
        };
        sessionsByWorld.set(restoredSession.worldId, [
          ...(sessionsByWorld.get(restoredSession.worldId) ?? []),
          restoredSession
        ]);
        messagesBySession.set(restoredSession.id, [...(messagesBySession.get(originalArchive?.sessionId ?? "") ?? [])]);
        archivesBySession.set(restoredSession.id, []);
        return Response.json({
          session: restoredSession
        });
      }

      throw new Error(`Unhandled fetch: ${url.pathname}${url.search}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders web chrome in Chinese by default and displays session data", async () => {
    renderWithI18n(<App />);

    await screen.findAllByText("Northreach");
    expect(screen.getByText("世界")).toBeTruthy();
    expect(screen.getByText("扩展包")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("core-guide")).toBeTruthy();
    expect((screen.getByLabelText("当前会话预设") as HTMLSelectElement).value).toBe("default-story");
    expect(await screen.findByText("The gatehouse is silent.")).toBeTruthy();
  });

  it("creates a world, auto-creates a session, sends a message, renders a pending block, and submits the response", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");

    await user.type(screen.getAllByLabelText("世界名称")[0]!, "Shattercoast");
    await user.type(screen.getAllByLabelText("世界描述")[0]!, "Storm-lashed islands");
    await user.click(screen.getAllByRole("button", { name: "创建世界" })[0]!);

    await screen.findAllByText("Shattercoast");
    await screen.findAllByText("session_02");

    await user.clear(screen.getByLabelText("输入"));
    await user.type(screen.getByLabelText("输入"), "Advance through the drift");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("Advance through the drift");
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

    await screen.findAllByText("Northreach");

    await user.click(screen.getAllByRole("button", { name: "创建快照" })[0]!);
    await screen.findByText("archive_01");

    await user.click(screen.getAllByRole("button", { name: "以分支恢复" })[0]!);

    await screen.findAllByText("session_02");
  });

  it("shows a session bootstrap action for the active world", async () => {
    renderWithI18n(<App />);

    await screen.findAllByText("Northreach");
    expect(screen.getAllByRole("button", { name: "开始新会话" }).length).toBeGreaterThan(0);
  });

  it("creates a new session with the selected preset and persists preset switches for the active session", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");

    await user.selectOptions(screen.getByLabelText("新会话预设"), "fallback-lab");
    await user.click(screen.getAllByRole("button", { name: "开始新会话" })[0]!);

    await screen.findAllByText("session_02");
    expect((screen.getByLabelText("当前会话预设") as HTMLSelectElement).value).toBe("fallback-lab");

    await user.selectOptions(screen.getByLabelText("当前会话预设"), "default-story");
    await waitFor(() => {
      expect((screen.getByLabelText("当前会话预设") as HTMLSelectElement).value).toBe("default-story");
    });
  });

  it("allows switching chrome text to English without translating runtime content", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");
    await user.click(screen.getAllByRole("button", { name: "English" })[0]!);

    expect(screen.getByText("Worlds")).toBeTruthy();
    expect(screen.getByText("Packages")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByLabelText("Session preset")).toBeTruthy();
    expect(screen.getByText("The gatehouse is silent.")).toBeTruthy();
  });
});
