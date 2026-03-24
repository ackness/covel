import { describe, expect, it } from "vitest";

import { createSession } from "../../domain/src/index.js";
import { FlowEngine } from "../src/index.js";

describe("FlowEngine i18n", () => {
  it("passes the default zh-CN locale to the model gateway", async () => {
    const modelCalls: Array<{ locale: string }> = [];
    const session = createSession({
      id: "session_01",
      worldId: "world_01",
      status: "active",
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    });
    const engine = new FlowEngine({
      sessions: {
        async getById() {
          return session;
        },
        async save() {}
      },
      messages: {
        async save() {},
        async listBySessionId() {
          return [];
        }
      },
      modelGateway: {
        async generateText(input) {
          modelCalls.push({
            locale: input.locale
          });
          return {
            content: "已收到",
            traceId: "trace_01"
          };
        }
      },
      commandBus: {
        async execute() {
          return {};
        }
      },
      createId(prefix) {
        return `${prefix}_01`;
      },
      now() {
        return new Date("2026-03-24T12:00:00.000Z");
      }
    });

    await engine.handle({
      requestId: "req_01",
      type: "send_message",
      sessionId: "session_01",
      payload: {
        content: "继续前进"
      }
    });

    expect(modelCalls).toEqual([
      {
        locale: "zh-CN"
      }
    ]);
  });

  it("passes an explicit English locale to the command bus", async () => {
    const commandCalls: Array<{ locale: string }> = [];
    const session = createSession({
      id: "session_01",
      worldId: "world_01",
      status: "active",
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    });
    const engine = new FlowEngine({
      sessions: {
        async getById() {
          return session;
        },
        async save() {}
      },
      messages: {
        async save() {},
        async listBySessionId() {
          return [];
        }
      },
      modelGateway: {
        async generateText() {
          return {
            content: "ok",
            traceId: "trace_01"
          };
        }
      },
      commandBus: {
        async execute(input) {
          commandCalls.push({
            locale: input.locale
          });
          return {
            content: "Guide package prepared options for ruins."
          };
        }
      },
      createId(prefix) {
        return `${prefix}_01`;
      },
      now() {
        return new Date("2026-03-24T12:00:00.000Z");
      }
    });

    await engine.handle({
      requestId: "req_01",
      type: "execute_command",
      sessionId: "session_01",
      locale: "en",
      payload: {
        command: "/guide ruins"
      }
    });

    expect(commandCalls).toEqual([
      {
        locale: "en"
      }
    ]);
  });
});
