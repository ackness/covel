import { expect, it, vi } from "vitest";
import type { SseEnvelope } from "@covel/shared";
import {
  startThemeOrchestrationHost,
  streamingThemeStory,
  themeSecrets,
} from "../../../../tests/e2e/helpers/theme-orchestration.js";

// Exercise the browser's real fixture without binding an HTTP socket.
vi.mock("../helpers/stage-render-browser.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../helpers/stage-render-browser.js")>();
  return {
    ...original,
    startStageRenderHost: async (
      ...args: Parameters<typeof original.createStageRenderFixture>
    ) => {
      const fixture = await original.createStageRenderFixture(...args);
      return {
        ...fixture,
        get app() {
          return fixture.app;
        },
        baseUrl: "http://localhost",
      };
    },
  };
});

async function* actionEvents(response: Response) {
  if (!response.body) throw new Error("Missing action stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines)
        if (line.startsWith("data: "))
          yield JSON.parse(line.slice(6)) as SseEnvelope;
    }
  } finally {
    reader.releaseLock();
  }
}

it("streams the theme fixture's public story before commit and preserves an explicit operation retry", async () => {
  const fixture = await startThemeOrchestrationHost();
  const { host } = fixture;
  try {
    // Match the browser flow's registry reload after installing its theme.
    await host.restart();
    for (let turn = 0; turn < 2; turn++) {
      if (turn === 1) fixture.allowChange();
      const response = await host.app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          type: "submit_actions",
          sessionId: host.sessionId,
          payload: {
            actions: [
              {
                kind: "say",
                seatId: "main",
                text:
                  turn === 0
                    ? "Tell the public story and record the change"
                    : "Try the refused change again",
              },
            ],
          },
        }),
      });
      expect(response.status).toBe(200);
      const events: SseEnvelope[] = [];
      const stream = actionEvents(response);
      let text = "";
      const observe = (event: SseEnvelope) => {
        events.push(event);
        expect(event.type, JSON.stringify(event.payload)).not.toBe(
          "runtime.failed",
        );
        if (event.type === "narrative.delta") {
          text =
            (event.payload.reset ? "" : text) +
            String(event.payload.delta ?? "");
          for (const secret of themeSecrets) expect(text).not.toContain(secret);
        }
      };
      const readUntilText = async (expected: string) => {
        while (true) {
          const { done, value } = await stream.next();
          if (done) break;
          observe(value);
          if (text.includes(expected)) return;
        }
        throw new Error(`Action stream ended before ${expected}`);
      };
      // Both chunks must arrive while the provider is held before completion.
      await readUntilText("Public streaming");
      expect(text).toBe("Public streaming");
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(turn);
      fixture.nextDelta(turn);
      await readUntilText(streamingThemeStory);
      expect(events.some((event) => event.type === "execution.completed")).toBe(
        false,
      );
      fixture.release(turn);
      for await (const event of stream) observe(event);
      expect(
        events.find((event) => event.type === "execution.completed"),
      ).toMatchObject({ payload: { committed: true } });
      expect(
        events.filter((event) => event.type === "operation.failed"),
      ).toHaveLength(turn === 0 ? 1 : 0);
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(turn + 1);
      const values = await host.store.queryPluginData({
        sessionId: host.sessionId,
        pluginId: "theme-change-probe",
        namespace: "values",
      });
      expect(values).toHaveLength(turn);
    }
    expect(fixture.calls).toEqual([
      "concealed",
      "delegate",
      "actor",
      "change",
      "story",
      "concealed",
      "delegate",
      "actor",
      "change",
      "story",
    ]);
    expect(
      await host.store.queryTraceEvents(host.sessionId, {
        types: ["operation.failed"],
      }),
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
