import { expect, it, vi } from "vitest";
import type { SseEnvelope } from "@covel/shared";
import {
  startThemeOrchestrationHost,
  committedThemeStory,
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

it("shows the theme story only as drafts before commit and preserves an explicit operation retry", async () => {
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
      const observe = (event: SseEnvelope) => {
        events.push(event);
        expect(event.type, JSON.stringify(event.payload)).not.toBe(
          "runtime.failed",
        );
        expect(event.type).not.toBe("narrative.delta");
        for (const secret of themeSecrets)
          expect(JSON.stringify(event.payload)).not.toContain(secret);
      };
      // Arguments and accepted output remain private while the provider is held.
      await fixture.waitForSubmission(turn);
      const beforeCommit = await host.store.listMessages(host.sessionId);
      expect(
        beforeCommit.some((message) =>
          message.content.includes(committedThemeStory),
        ),
      ).toBe(turn > 0);
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(turn);
      fixture.continueArguments(turn);
      fixture.release(turn);
      for await (const event of stream) observe(event);
      const stories = events.filter(
        (event) => event.type === "narrative.completed",
      );
      expect(stories).toHaveLength(1);
      expect(stories[0]?.payload.content).toContain(committedThemeStory);
      const beforeStory = events.slice(
        0,
        events.findIndex((event) => event.type === "narrative.completed"),
      );
      // Before the commit the story reaches the player only as drafts.
      const drafts = beforeStory.filter((event) =>
        event.type.startsWith("output."),
      );
      expect(JSON.stringify(drafts)).toContain(committedThemeStory);
      expect(
        JSON.stringify(
          beforeStory.filter((event) => !event.type.startsWith("output.")),
        ),
      ).not.toContain(committedThemeStory);
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
