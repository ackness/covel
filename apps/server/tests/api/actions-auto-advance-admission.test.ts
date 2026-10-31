import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFixture, events, gate } from "./__helpers/auto-advance.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("advancement admission", () => {
  it.each(["committed input", "invalid answer", "duplicate answer"])(
    "keeps the running chain after rejecting a %s",
    async (refusal) => {
      const reached = gate();
      const release = gate();
      let signal: AbortSignal | undefined;
      const interaction = {
        turnId: "question-turn",
        interactionId: "route",
        type: "form",
      };
      const f = await advanceFixture({
        limit: 1,
        prepare: async (_builtin, store, sessionId) => {
          await store.appendTurnMessage({
            id: "question",
            sessionId,
            turnId: interaction.turnId,
            sourceType: "runtime",
            sourcePluginId: "observer",
            role: "assistant",
            content: "",
            order: 0,
            createdAt: new Date().toISOString(),
            pendingInput: [
              {
                ...interaction,
                title: "Choose a route",
                actionKind: "say",
                submitLabel: "Go",
                fields: [
                  {
                    type: "text",
                    name: "route",
                    label: "Route",
                    required: true,
                  },
                ],
                narrativeTemplate: "{{route}}",
              },
            ],
          });
        },
        onGenerate: async (index, request) => {
          if (index !== 1) return;
          signal = request.signal;
          reached.resolve();
          await release.promise;
        },
      });
      const input = {
        inputMessageId: "root-input",
        actions: [{ kind: "say", interaction, fields: { route: "Left" } }],
      };
      try {
        const running = f.post(input).then((response) => response.text());
        await Promise.race([
          reached.promise,
          running.then((text) => {
            throw new Error(`Round never started: ${text}`);
          }),
        ]);
        const rejected = await f.post(
          refusal === "committed input"
            ? input
            : {
                actions: [
                  {
                    kind: "say",
                    interaction,
                    fields:
                      refusal === "invalid answer" ? {} : { route: "Left" },
                  },
                ],
              },
        );
        expect(signal?.aborted).toBe(false);
        expect(await f.status()).toMatchObject({
          state: "running",
          advance: { phase: "running", round: 1 },
        });
        expect(rejected.status).toBe(200);
        const rejectedEvents = events(await rejected.text());
        expect(rejectedEvents.map((event) => event.type)).toEqual([
          "error.occurred",
        ]);
        expect(rejectedEvents[0]?.payload).toMatchObject({
          code:
            refusal === "committed input"
              ? "input_already_committed"
              : refusal === "invalid answer"
                ? "form_rejected"
                : "interaction_already_submitted",
        });
        release.resolve();
        const stream = events(await running);
        expect(
          stream
            .filter((event) => event.type === "execution.round.completed")
            .map((event) => event.payload.committed),
        ).toEqual([true, true]);
        expect(f.calls()).toBe(2);
        expect(await f.store.listPlayerInputs(f.sessionId)).toHaveLength(1);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(5);
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
});
