import { expect, it } from "vitest";
import type { SseEnvelope } from "@covel/shared";
import { createStageRenderFixture } from "../helpers/stage-render-browser.js";
import { submittedOutput } from "../helpers/output-submission.js";

it.each([false, true])(
  "commits segment stories using the registered narrative contract (custom adapter: %s)",
  async (custom) => {
    let calls = 0;
    const fixture = await createStageRenderFixture(
      custom
        ? {
            llmAdapter: {
              async generate(request) {
                calls++;
                expect(
                  request.tools?.find((tool) => tool.name === "submit-output")
                    ?.parameters,
                ).toMatchObject({
                  required: expect.arrayContaining(["segments"]),
                });
                return submittedOutput({
                  segments: [
                    {
                      kind: "dialogue",
                      speaker: "Mira",
                      text: "A complete custom paragraph.",
                    },
                  ],
                  cues: { scene: "Library", present: ["Mira"] },
                  yield: "user",
                });
              },
            },
          }
        : {},
    );
    try {
      const response = await fixture.app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          sessionId: fixture.sessionId,
          type: "submit_actions",
          payload: {
            actions: [{ kind: "say", text: "Mira enters the library" }],
          },
        }),
      });
      expect(response.status).toBe(200);
      const events: SseEnvelope[] = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.at(-1)).toMatchObject({
        type: "execution.completed",
        payload: { committed: true },
      });
      expect(events.filter((event) => event.type === "runtime.failed")).toEqual(
        [],
      );
      const messages = (
        await fixture.store.listMessages(fixture.sessionId)
      ).filter((message) => message.role === "assistant");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe(
        custom
          ? "A complete custom paragraph."
          : "Public dialogue 1.\n\nA readable line without a portrait.",
      );
      if (custom) expect(calls).toBe(1);
      expect(
        (
          await fixture.store.getPluginData(
            fixture.sessionId,
            "scene-stage",
            "direction",
            "current",
          )
        )?.value,
      ).toMatchObject({
        actors: expect.arrayContaining([
          expect.objectContaining({ characterId: "mira" }),
        ]),
      });
    } finally {
      await fixture.close();
    }
  },
);
