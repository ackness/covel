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
    const commands = [
      {
        name: "guide",
        description: "Generate a guide block.",
        usage: "/guide [topic]",
        positionalHints: ["topic"]
      },
      {
        name: "world-seeds",
        description: "Inspect staged world seed content.",
        usage: "/world-seeds [seedId]",
        examples: ["/world-seeds", "/world-seeds --seed legacy-wuxia-nine-provinces"],
        positionalHints: ["seedId"],
        flagHints: [
          {
            name: "--seed",
            description: "Inspect a staged world seed by id.",
            takesValue: true
          }
        ]
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
      spanId: string;
      component: string;
      eventType: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>>();
    const packageStateBySession = new Map<string, Array<{
      scope: "session" | "world";
      ownerId: string;
      packageName: string;
      collection: string;
      key: string;
      value: Record<string, unknown>;
      updatedAt: string;
    }>>([
      [
        "session_01",
        [
          {
            scope: "session",
            ownerId: "session_01",
            packageName: "core-guide",
            collection: "guide_state",
            key: "latest-choice",
            value: {
              selected: "opt_a",
              label: "Advance",
              topic: "Northreach gatehouse"
            },
            updatedAt: "2026-03-24T12:00:04.000Z"
          }
        ]
      ]
    ]);
    const workflowSnapshotsBySession = new Map<string, Array<{
      runId: string;
      stepId: string;
      sessionId: string;
      status: "running" | "suspended" | "completed" | "failed";
      suspendPayload?: Record<string, unknown>;
      resumeData?: Record<string, unknown>;
      updatedAt: string;
    }>>([
      [
        "session_01",
        [
          {
            runId: "workflow_01",
            stepId: "await-choice",
            sessionId: "session_01",
            status: "suspended",
            suspendPayload: {
              blockId: "blk_guide_01"
            },
            updatedAt: "2026-03-24T12:00:05.000Z"
          }
        ]
      ]
    ]);
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

      if (url.pathname === "/commands") {
        return Response.json(commands);
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
        packageStateBySession.set(session.id, []);
        workflowSnapshotsBySession.set(session.id, []);
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

      if (/^\/sessions\/[^/]+\/workflow-snapshots$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[2] ?? "";
        return Response.json(workflowSnapshotsBySession.get(sessionId) ?? []);
      }

      if (/^\/sessions\/[^/]+\/package-state$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[2] ?? "";
        const packageName = url.searchParams.get("packageName");
        const collection = url.searchParams.get("collection");
        return Response.json(
          (packageStateBySession.get(sessionId) ?? []).filter((record) =>
            (!packageName || record.packageName === packageName) &&
            (!collection || record.collection === collection)
          )
        );
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
            command?: string;
            response?: {
              selected?: string;
            };
          };
        };
        if (body.type === "send_message") {
          const isStarterOpening = String(body.payload.content ?? "").includes("雾港十三号");
          const userMessage = {
            id: `msg_${String(++messageCounter).padStart(2, "0")}`,
            role: "user" as const,
            content: String(body.payload.content ?? ""),
            createdAt: "2026-03-24T12:00:02.500Z"
          };
          const assistantMessage = {
            id: `msg_${String(++messageCounter).padStart(2, "0")}`,
            role: "assistant" as const,
            content: isStarterOpening
              ? "潮雾拍在栈桥护栏上，灯塔的鲸油味顺着风灌进来。"
              : "The snow parts.",
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
              spanId: "span_01",
              component: "model-gateway",
              eventType: "model.completed",
              payload: {
                model: "demo"
              },
              createdAt: "2026-03-24T12:00:03.000Z"
            }
          ]);
          const events: unknown[] = [
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
                delta: assistantMessage.content
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
                content: assistantMessage.content
              }
            },
            {
              type: "flow.completed",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: body.sessionId,
              turnId: "turn_01",
              flowId: "flow_01",
              seq: isStarterOpening ? 3 : 4,
              timestamp: "2026-03-24T12:00:02.000Z",
              payload: {
                turnId: "turn_01"
              }
            }
          ];

          if (!isStarterOpening) {
            events.splice(2, 0, {
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
            });
          }

          return createSseResponse(events);
        }

        if (body.type === "execute_command") {
          if (String(body.payload.command ?? "").startsWith("/guide")) {
            workflowSnapshotsBySession.set(body.sessionId, [
              {
                runId: "flow_guide_01",
                stepId: "await-choice",
                sessionId: body.sessionId,
                status: "suspended",
                suspendPayload: {
                  blockId: "blk_guide"
                },
                updatedAt: "2026-03-24T12:00:03.500Z"
              }
            ]);

            return createSseResponse([
              {
                type: "message.completed",
                requestId: "req_guide",
                traceId: "tr_guide",
                sessionId: body.sessionId,
                turnId: "turn_guide",
                flowId: "flow_guide_01",
                seq: 1,
                timestamp: "2026-03-24T12:00:03.000Z",
                payload: {
                  messageId: `msg_${String(++messageCounter).padStart(2, "0")}`,
                  content: "引导扩展已准备好选项。"
                }
              },
              {
                type: "block.emitted",
                requestId: "req_guide",
                traceId: "tr_guide",
                sessionId: body.sessionId,
                turnId: "turn_guide",
                flowId: "flow_guide_01",
                seq: 2,
                timestamp: "2026-03-24T12:00:03.100Z",
                payload: {
                  block: {
                    id: "blk_guide",
                    type: "choices",
                    version: "1.0",
                    meta: {
                      package: "core-guide",
                      requestId: "req_guide",
                      traceId: "tr_guide",
                      sessionId: body.sessionId,
                      turnId: "turn_guide"
                    },
                    interaction: {
                      requiresResponse: true,
                      responseSchema: "schemas/blocks/choices.response.json",
                      submitAs: "block_response",
                      resumePolicy: "resume_current_flow"
                    },
                    data: {
                      title: "雾港十三号 的下一步",
                      options: [
                        { id: "opt_a", label: "继续前进" },
                        { id: "opt_b", label: "观察周围" }
                      ]
                    }
                  }
                }
              },
              {
                type: "workflow.suspended",
                requestId: "req_guide",
                traceId: "tr_guide",
                sessionId: body.sessionId,
                turnId: "turn_guide",
                flowId: "flow_guide_01",
                seq: 3,
                timestamp: "2026-03-24T12:00:03.200Z",
                payload: {
                  runId: "flow_guide_01",
                  workflowId: "core-guide",
                  currentStep: "await-choice",
                  reason: "waiting for player input"
                }
              }
            ]);
          }

          const assistantMessage = {
            id: `msg_${String(++messageCounter).padStart(2, "0")}`,
            role: "assistant" as const,
            content: "已暂存 3 个世界种子：\n- 九州江湖录 (legacy-wuxia-nine-provinces) [元数据 zh-CN / 内容 zh-CN]",
            createdAt: "2026-03-24T12:00:03.000Z"
          };
          messagesBySession.set(body.sessionId, [
            ...(messagesBySession.get(body.sessionId) ?? []),
            assistantMessage
          ]);
          return createSseResponse([
            {
              type: "message.completed",
              requestId: "req_03",
              traceId: "tr_cmd_01",
              sessionId: body.sessionId,
              turnId: "turn_03",
              flowId: "flow_03",
              seq: 1,
              timestamp: "2026-03-24T12:00:03.000Z",
              payload: {
                messageId: assistantMessage.id,
                content: assistantMessage.content
              }
            },
            {
              type: "flow.completed",
              requestId: "req_03",
              traceId: "tr_cmd_01",
              sessionId: body.sessionId,
              turnId: "turn_03",
              flowId: "flow_03",
              seq: 2,
              timestamp: "2026-03-24T12:00:03.500Z",
              payload: {
                turnId: "turn_03"
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
            spanId: "span_02",
            component: "flow-engine",
            eventType: "resume.completed",
            payload: {
              selected: body.payload.response?.selected ?? null
            },
            createdAt: "2026-03-24T12:00:04.000Z"
          }
        ]);
        packageStateBySession.set(body.sessionId, [
          {
            scope: "session",
            ownerId: body.sessionId,
            packageName: "core-guide",
            collection: "guide_state",
            key: "latest-choice",
            value: {
              selected: body.payload.response?.selected ?? null,
              label: body.payload.response?.selected ?? null,
              topic: "雾港十三号"
            },
            updatedAt: "2026-03-24T12:00:04.000Z"
          }
        ]);
        workflowSnapshotsBySession.set(body.sessionId, [
          {
            runId: "flow_01",
            stepId: "resume",
            sessionId: body.sessionId,
            status: "completed",
            resumeData: {
              selected: body.payload.response?.selected ?? null
            },
            updatedAt: "2026-03-24T12:00:04.000Z"
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
        packageStateBySession.set(restoredSession.id, [...(packageStateBySession.get(originalArchive?.sessionId ?? "") ?? [])]);
        workflowSnapshotsBySession.set(restoredSession.id, [...(workflowSnapshotsBySession.get(originalArchive?.sessionId ?? "") ?? [])]);
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
    await screen.findByText("The gatehouse is silent.");
    expect(screen.getByLabelText("世界导航")).toBeTruthy();
    expect(screen.getByLabelText("当前工作区")).toBeTruthy();
    expect(screen.getByLabelText("上下文与调试")).toBeTruthy();
    expect(screen.getByText("预设")).toBeTruthy();
    expect(screen.getByRole("button", { name: "会话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "调试" })).toBeTruthy();
    expect(screen.getAllByText("空闲").length).toBeGreaterThan(0);
    expect(screen.queryByText("运行时活动")).toBeNull();
    expect((screen.getByLabelText("当前会话预设") as HTMLSelectElement).value).toBe("default-story");
  });

  it("keeps the debug tab collapsed by default and only reveals runtime details on demand", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");
    expect(screen.queryByText("运行时活动")).toBeNull();

    await user.click(screen.getByRole("button", { name: "调试" }));

    expect(screen.getByText("运行时活动")).toBeTruthy();
    expect(screen.getAllByText("工作流快照").length).toBeGreaterThan(0);
    expect(screen.getByText("core-guide")).toBeTruthy();
  });

  it("auto-sends the opener when creating a starter world and surfaces the pending guide block above the composer", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");
    await user.click(screen.getAllByRole("button", { name: "创建示例世界并开始" })[0]!);

    await screen.findAllByText("雾港十三号");
    await screen.findByText("我刚抵达雾港十三号的北栈桥，先告诉我眼前最值得注意的三件事。");
    await screen.findByText("潮雾拍在栈桥护栏上，灯塔的鲸油味顺着风灌进来。");
    const pendingRegion = await screen.findByLabelText("等待交互");
    expect(pendingRegion).toBeTruthy();
    expect(screen.getByText("雾港十三号 的下一步")).toBeTruthy();

    const actionCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => new URL(String(call[0]), "http://runtime.local").pathname === "/actions")
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as {
        type: string;
        payload?: {
          content?: string;
          command?: string;
        };
      });

    expect(actionCalls.slice(-2)).toEqual([
      expect.objectContaining({
        type: "send_message",
        payload: {
          content: "我刚抵达雾港十三号的北栈桥，先告诉我眼前最值得注意的三件事。"
        }
      }),
      expect.objectContaining({
        type: "execute_command",
        payload: {
          command: expect.stringMatching(/^\/guide\b/)
        }
      })
    ]);
  });

  it("creates a world, auto-creates a session, sends a message, renders a pending block, and submits the response", async () => {
    const view = renderWithI18n(<App />);
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
    expect(view.container.querySelector(".pending-block")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Advance" }));

    await screen.findByText("You advance into the drift.");
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Advance" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Wait" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("creates an archive and restores it as a fork", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");

    await user.click(screen.getAllByRole("button", { name: "创建快照" })[0]!);
    await user.click(screen.getByRole("button", { name: "会话" }));
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

  it("routes slash-prefixed input through execute_command", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");
    await screen.findByLabelText("输入");

    await user.clear(screen.getByLabelText("输入"));
    await user.type(screen.getByLabelText("输入"), "/wo");
    await screen.findByText("/world-seeds [seedId]");
    await user.keyboard("{Tab}");
    expect((screen.getByLabelText("输入") as HTMLTextAreaElement).value).toBe("/world-seeds ");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("已暂存 3 个世界种子：", { exact: false });

    const actionCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => new URL(String(call[0]), "http://runtime.local").pathname === "/actions");
    const latestActionBody = JSON.parse(String((actionCalls.at(-1)?.[1] as RequestInit | undefined)?.body)) as {
      type: string;
      payload: {
        command?: string;
        content?: string;
      };
    };

    expect(latestActionBody).toMatchObject({
      type: "execute_command",
      payload: {
        command: "/world-seeds"
      }
    });
  });

  it("allows switching chrome text to English without translating runtime content", async () => {
    renderWithI18n(<App />);
    const user = userEvent.setup();

    await screen.findAllByText("Northreach");
    await screen.findByText("The gatehouse is silent.");
    await user.click(screen.getAllByRole("button", { name: "English" })[0]!);

    expect(screen.getByLabelText("World navigator")).toBeTruthy();
    expect(screen.getByLabelText("Active workspace")).toBeTruthy();
    expect(screen.getByLabelText("Context and debug")).toBeTruthy();
    expect(screen.getByText("Worlds")).toBeTruthy();
    expect(screen.getAllByText("Idle").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Session preset")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Debug" })).toBeTruthy();
    expect(screen.getByText("The gatehouse is silent.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Debug" }));
    expect(screen.getAllByText("Packages").length).toBeGreaterThan(0);
  });
});
