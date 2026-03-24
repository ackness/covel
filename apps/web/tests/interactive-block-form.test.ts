// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import {
  cleanup,
  render,
  screen
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlockEnvelope } from "../../../modules/contracts/src/index.js";
import {
  createInteractiveBlock
} from "./helpers/fixtures.js";
import {
  createSseResponse,
  installFetchStub,
  serializeSseEvent
} from "./helpers/fetch-stub.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface InteractiveBlockFormProps {
  runtimeBaseUrl: string;
  block: BlockEnvelope;
  sessionId: string;
  turnId: string;
  createRequestId(): string;
  onSubmitted?(blockId: string): void;
}

interface InteractiveBlockFormModule {
  InteractiveBlockForm: ComponentType<InteractiveBlockFormProps>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("apps/web InteractiveBlockForm", () => {
  it("submits BlockResponse with required linkage fields and locks the block afterwards", async () => {
    const { InteractiveBlockForm } = await loadWebModule<InteractiveBlockFormModule>(
      "components/interactive-block-form.ts"
    );
    const block = createInteractiveBlock();
    const onSubmitted = vi.fn();
    const fetchStub = installFetchStub([
      {
        method: "POST",
        url: "http://runtime.test/actions",
        handler: async () =>
          createSseResponse([
            serializeSseEvent({
              id: 1,
              type: "flow.completed",
              data: {
                requestId: "req_block_01",
                traceId: "tr_01",
                sessionId: "ses_01",
                turnId: "turn_01",
                flowId: "flow_01",
                seq: 1,
                timestamp: "2026-03-24T12:00:00.000Z",
                type: "flow.completed",
                payload: {
                  outcome: "ok"
                }
              }
            })
          ])
      }
    ]);
    const user = userEvent.setup();

    render(createElement(InteractiveBlockForm, {
      runtimeBaseUrl: "http://runtime.test",
      block,
      sessionId: "ses_01",
      turnId: "turn_01",
      createRequestId: () => "req_block_01",
      onSubmitted
    }));

    await user.click(screen.getByLabelText("继续前进"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    await expect(fetchStub.calls[0]?.json()).resolves.toEqual({
      requestId: "req_block_01",
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
    expect(onSubmitted).toHaveBeenCalledWith("blk_01");
    expect(
      (screen.getByRole("button", { name: "Submit response" }) as HTMLButtonElement).disabled
    ).toBe(true);

    fetchStub.restore();
  });
});
