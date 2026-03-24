import { describe, expect, it } from "vitest";

import { ActionRequestSchema } from "../src/index.js";
import {
  expectSchemaAccepts,
  expectSchemaRejects
} from "./helpers.js";

describe("ActionRequestSchema", () => {
  it("accepts the v1 send_message action shape", () => {
    expectSchemaAccepts(ActionRequestSchema, {
      requestId: "req_01",
      type: "send_message",
      sessionId: "ses_01",
      locale: "zh-CN",
      payload: {
        content: "继续前进"
      }
    });
  });

  it("accepts execute_command and submit_block_response variants", () => {
    const executeCommand = ActionRequestSchema.safeParse({
      requestId: "req_02",
      type: "execute_command",
      sessionId: "ses_01",
      locale: "en",
      payload: {
        command: "/guide",
        args: {
          topic: "cave"
        }
      }
    });

    const submitBlockResponse = ActionRequestSchema.safeParse({
      requestId: "req_03",
      type: "submit_block_response",
      sessionId: "ses_01",
      payload: {
        blockId: "blk_01",
        blockType: "choices",
        sessionId: "ses_01",
        turnId: "turn_01",
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(executeCommand.success).toBe(true);
    expect(submitBlockResponse.success).toBe(true);
  });

  it("rejects an unsupported action type", () => {
    expectSchemaRejects(ActionRequestSchema, {
      requestId: "req_04",
      type: "delete_session",
      sessionId: "ses_01",
      payload: {}
    });
  });

  it("rejects a request without requestId and sessionId", () => {
    expectSchemaRejects(ActionRequestSchema, {
      type: "send_message",
      payload: {
        content: "继续前进"
      }
    });
  });
});
