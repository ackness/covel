// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeCommand, sendMessage, submitBlockResponse } from "../src/api.js";
import {
  createSseResponse,
  installFetchStub
} from "./helpers/fetch-stub.js";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("apps/web api i18n transport", () => {
  it("uses zh-CN by default for action headers and payloads", async () => {
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: "http://localhost/actions",
        handler: async () => createSseResponse([])
      }
    ]);

    await sendMessage({
      sessionId: "session_01",
      content: "继续前进"
    });

    expect(fetchStub.calls[0]?.headers.get("accept-language")).toBe("zh-CN");
    await expect(fetchStub.calls[0]?.json()).resolves.toMatchObject({
      type: "send_message",
      locale: "zh-CN"
    });

    fetchStub.restore();
  });

  it("uses the selected English locale for block responses", async () => {
    window.localStorage.setItem("covel.locale", "en");
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: "http://localhost/actions",
        handler: async () => createSseResponse([])
      }
    ]);

    await submitBlockResponse({
      sessionId: "session_01",
      response: {
        blockId: "blk_01",
        blockType: "choices",
        sessionId: "session_01",
        turnId: "turn_01",
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(fetchStub.calls[0]?.headers.get("accept-language")).toBe("en");
    await expect(fetchStub.calls[0]?.json()).resolves.toMatchObject({
      type: "submit_block_response",
      locale: "en"
    });

    fetchStub.restore();
  });

  it("uses the selected locale for execute_command payloads", async () => {
    window.localStorage.setItem("covel.locale", "en");
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: "http://localhost/actions",
        handler: async () => createSseResponse([])
      }
    ]);

    await executeCommand({
      sessionId: "session_01",
      command: "/world-seeds"
    });

    expect(fetchStub.calls[0]?.headers.get("accept-language")).toBe("en");
    await expect(fetchStub.calls[0]?.json()).resolves.toMatchObject({
      type: "execute_command",
      locale: "en",
      payload: {
        command: "/world-seeds"
      }
    });

    fetchStub.restore();
  });
});
