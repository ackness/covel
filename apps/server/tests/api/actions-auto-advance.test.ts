import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookPipeline } from "@covel/runtime";
import type { Proposal } from "@covel/shared";
import { advanceFixture, events } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("committed story advancement", () => {
  it.each(["no plugins", "empty story"])(
    "ends without an automatic execution for %s",
    async (kind) => {
      const f = await advanceFixture({
        emptyOutput: kind === "empty story",
        prepare: async (_builtin, store, sessionId) => {
          if (kind === "no plugins")
            await store.updateSession(sessionId, { activePlugins: [] });
        },
      });
      try {
        const stream = events(await (await f.post()).text());
        expect(
          stream.filter((event) => event.type === "execution.started"),
        ).toHaveLength(1);
        expect(
          stream.filter((event) => event.type === "error.occurred"),
        ).toHaveLength(0);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload.reason,
        ).toBe(
          kind === "empty story" ? "execution-failed" : "no-eligible-story",
        );
        expect(
          (await f.store.listMessages(f.sessionId)).filter(
            (message) => message.role === "assistant",
          ),
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
  it.each([false, true])(
    "uses the original human seat, falling back only when it disappears (%s)",
    async (removeSeat) => {
      const f = await advanceFixture({
        limit: 1,
        prepare: async (_builtin, store, sessionId) => {
          await store.updateSession(sessionId, {
            seats: [
              {
                id: "first",
                controller: "human",
                role: "spectator",
                characters: [],
              },
              {
                id: "chosen",
                controller: "human",
                role: "host",
                characters: "auto",
              },
            ],
          });
        },
      });
      const add = f.store.addTraceEvent.bind(f.store);
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          removeSeat &&
          event.type === "execution.advance" &&
          (event.payload as { phase: string }).phase === "waiting"
        )
          await f.store.updateSession(f.sessionId, {
            seats: [
              {
                id: "first",
                controller: "human",
                role: "spectator",
                characters: [],
              },
            ],
          });
      });
      try {
        await (
          await f.post({
            actions: [{ kind: "direct", seatId: "chosen", text: "Begin" }],
          })
        ).text();
        expect(f.calls()).toBe(2);
        const observations = await f.store.listPluginData(
          f.sessionId,
          "observer",
          "rounds",
        );
        expect(
          observations.map(
            (row) => (row.value as { actions: unknown }).actions,
          ),
        ).toContainEqual([
          {
            kind: "advance",
            source: "system",
            seatId: removeSeat ? "first" : "chosen",
          },
        ]);
      } finally {
        await f.close();
      }
    },
  );
  it("commits three independent stories with one player row and a frozen clock", async () => {
    const f = await advanceFixture({
      yields: ["continue", "continue", "user", "user"],
    });
    try {
      const response = await f.post();
      const stream = events(await response.text());
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(3);
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(3);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      expect(
        stream
          .filter((event) => event.type === "execution.advance")
          .map((event) => event.payload.phase),
      ).toEqual(["waiting", "running", "waiting", "running", "stopped"]);
      const turns = await f.store.queryTurnResults(f.sessionId, {});
      expect(turns).toHaveLength(3);
      expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(3);
      expect(turns.every((turn) => turn.commitStatus === "committed")).toBe(
        true,
      );
      expect(turns.filter((turn) => turn.origin === "player")).toHaveLength(1);
      const messages = await f.store.listMessages(f.sessionId);
      expect(
        messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(
        messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      ).toEqual(["Story 1.", "Story 2.", "Story 3."]);
      const observations = await f.store.listPluginData(
        f.sessionId,
        "observer",
        "rounds",
      );
      expect(observations).toHaveLength(3);
      expect(
        observations.map(
          (row) => (row.value as { logicalTurn: number }).logicalTurn,
        ),
      ).toEqual([5, 5, 5]);
      const actions = observations.map(
        (row) => (row.value as { actions: unknown[] }).actions,
      );
      expect(actions).toContainEqual([
        { kind: "advance", source: "system", seatId: "human" },
      ]);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(5);
      await (await f.post({ actions: [{ kind: "say", text: "Next" }] })).text();
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(6);
      expect(
        (await f.store.listPluginData(f.sessionId, "observer", "rounds")).some(
          (row) => (row.value as { logicalTurn: number }).logicalTurn === 6,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("advances the opening without counting it and gives the first player input its own identity", async () => {
    const f = await advanceFixture({ yields: ["continue", "user", "user"] });
    try {
      await f.store.updateSession(f.sessionId, {
        phase: "setup",
        completedPlayerTurns: 0,
      });
      const opening = events(await (await f.post({}, "start_session")).text());
      expect(
        opening.filter((event) => event.type === "execution.started"),
      ).toHaveLength(3);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(0);
      await (await f.post()).text();
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(1);
      const observations = await f.store.listPluginData(
        f.sessionId,
        "observer",
        "rounds",
      );
      expect(
        observations.every(
          (row) => (row.value as { logicalTurn: number }).logicalTurn === 1,
        ),
      ).toBe(true);
      const starts = await f.store.queryTraceEvents(f.sessionId, {
        types: ["turn.started"],
      });
      const roots = starts.map(
        (event) =>
          (event.payload as { advancement: { rootId: string } }).advancement
            .rootId,
      );
      expect(new Set(roots.slice(0, 3)).size).toBe(1);
      expect(roots[3]).not.toBe(roots[0]);
    } finally {
      await f.close();
    }
  });
  it.each([undefined, 0, 1, 10])(
    "bounds an always-continuing provider at limit %s",
    async (limit) => {
      const f = await advanceFixture({ limit });
      try {
        const stream = events(await (await f.post()).text());
        expect(f.calls()).toBe(1 + (limit ?? 3));
        expect(
          stream.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload.reason,
        ).toBe(limit === 0 ? "disabled" : "limit");
      } finally {
        await f.close();
      }
    },
  );
  it.each(["rewrite", "reject", "continue"])(
    "uses the proposal hook's committed decision: %s",
    async (mode) => {
      const hooks = createHookPipeline();
      hooks.register<{ proposal: Proposal }>({
        id: "story-guard",
        event: "PreStateCommit",
        handler: async (_ctx, { proposal }) =>
          proposal.type !== "narrative.append"
            ? { action: "continue" }
            : mode === "reject"
              ? { action: "abort", reason: "Story refused" }
              : {
                  action: "continue",
                  replace: {
                    proposal: {
                      ...proposal,
                      payload: {
                        ...proposal.payload,
                        yield: mode === "continue" ? "continue" : "user",
                      },
                    },
                  },
                },
      });
      const f = await advanceFixture({
        hooks,
        limit: 1,
        yields: mode === "continue" ? ["user", "user"] : undefined,
      });
      try {
        const stream = events(await (await f.post()).text());
        expect(f.calls()).toBe(mode === "continue" ? 2 : 1);
        expect(
          stream.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  it.each(["absent", "ambiguous", "user"])(
    "ends normally when the story signal is %s",
    async (kind) => {
      const f = await advanceFixture({
        noProvider: kind === "absent",
        ambiguous: kind === "ambiguous",
        yields: kind === "user" ? [undefined] : undefined,
      });
      try {
        const stream = events(await (await f.post()).text());
        expect(
          stream.filter((event) => event.type === "execution.started"),
        ).toHaveLength(1);
        expect(
          stream.filter((event) => event.type === "error.occurred"),
        ).toHaveLength(0);
        expect(
          stream.find((event) => event.type === "execution.advance")?.payload
            .reason,
        ).toBe(
          kind === "absent"
            ? "no-eligible-story"
            : kind === "ambiguous"
              ? "ambiguous-story"
              : "yielded-to-player",
        );
      } finally {
        await f.close();
      }
    },
  );
});
