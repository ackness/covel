import * as turnControl from "../../src/routes/api/turn-control.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFixture, events, gate } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("request-owned advancement", () => {
  it.each(["waiting", "running"])(
    "new input owns the stream after interrupting an automatic round that is %s",
    async (phase) => {
      const reached = gate(),
        release = gate();
      const f = await advanceFixture({
        yields:
          phase === "waiting"
            ? ["continue", "user"]
            : ["continue", "continue", "user"],
        onGenerate: async (index, request) => {
          if (phase !== "running" || index !== 1) return;
          reached.resolve();
          await new Promise<void>((_, reject) => {
            const abort = () =>
              reject(new DOMException("Stopped", "AbortError"));
            if (request.signal?.aborted) abort();
            else
              request.signal?.addEventListener("abort", abort, { once: true });
          });
        },
      });
      const add = f.store.addTraceEvent.bind(f.store);
      let held = false;
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          phase === "waiting" &&
          !held &&
          event.type === "execution.advance" &&
          (event.payload as { phase: string }).phase === "waiting"
        ) {
          held = true;
          reached.resolve();
          await release.promise;
        }
      });
      try {
        const older = f.post().then((response) => response.text());
        await reached.promise;
        const newer = await (
          await f.post({ actions: [{ kind: "say", text: "Change course" }] })
        ).text();
        release.resolve();
        const oldStream = events(await older),
          newStream = events(newer);
        expect(
          oldStream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload.reason,
        ).toBe("new-input");
        expect(
          oldStream.filter((event) => event.type === "narrative.completed"),
        ).toHaveLength(1);
        expect(
          newStream.filter((event) => event.type === "narrative.completed"),
        ).toHaveLength(1);
        expect(
          newStream.filter((event) => event.type === "execution.started"),
        ).toHaveLength(1);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(6);
        expect(
          (await f.store.queryTurnResults(f.sessionId, {})).some(
            (row) => row.commitStatus === "pending",
          ),
        ).toBe(false);
        expect(await f.status()).toMatchObject({ state: "completed" });
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
  it("stops a waiting round without inventing a turn and reports the live gap", async () => {
    const f = await advanceFixture();
    const waiting = gate(),
      release = gate();
    const add = f.store.addTraceEvent.bind(f.store);
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      if (
        event.type === "execution.advance" &&
        (event.payload as { phase: string }).phase === "waiting"
      ) {
        waiting.resolve();
        await release.promise;
      }
    });
    try {
      const result = f.post().then((response) => response.text());
      await waiting.promise;
      expect(await f.status()).toMatchObject({
        state: "running",
        advance: { phase: "waiting", round: 1, limit: 3 },
      });
      await f.stop();
      await f.stop();
      release.resolve();
      const stream = events(await result);
      expect(f.calls()).toBe(1);
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      expect(stream.at(-1)?.payload.committed).toBe(true);
      expect(
        stream.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("player-stop");
      expect(await f.status()).toMatchObject({ state: "completed" });
      expect(await f.store.queryTurnResults(f.sessionId, {})).toHaveLength(1);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("aborts a running generated round; its explicit retry keeps provenance and runs once", async () => {
    const running = gate();
    const f = await advanceFixture({
      onGenerate: async (index, request) => {
        if (index !== 1) return;
        running.resolve();
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new DOMException("Stopped", "AbortError"));
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    try {
      const result = f.post().then((response) => response.text());
      await running.promise;
      const live = await f.status();
      expect(live).toMatchObject({
        state: "running",
        advance: { phase: "running", round: 1 },
      });
      await f.stop();
      const stream = events(await result);
      expect(f.calls()).toBe(2);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      const status = await f.status();
      expect(status).toMatchObject({
        state: "failed",
        origin: "continuation",
        retry: { type: "retry_turn", payload: {} },
      });
      const retry = events(
        await (
          await f.post({ recoverFromTurnId: status.turnId }, "retry_turn")
        ).text(),
      );
      expect(
        retry.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(f.calls()).toBe(3);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(5);
      const starts = await f.store.queryTraceEvents(f.sessionId, {
        types: ["turn.started"],
      });
      const provenance = starts.map(
        (event) => (event.payload as { advancement: unknown }).advancement,
      );
      expect(provenance[1]).toEqual(provenance[2]);
      expect(provenance[2]).toMatchObject({
        logicalTurn: 5,
        kind: "advance",
        actions: [{ kind: "advance", source: "system", seatId: "human" }],
      });
    } finally {
      await f.close();
    }
  });
  it("new input cancels future rounds without aborting the ordinary root", async () => {
    const started = gate(),
      release = gate(),
      admitted = gate();
    const register = turnControl.registerActionRequest;
    let registrations = 0;
    vi.spyOn(turnControl, "registerActionRequest").mockImplementation(
      (...args) => {
        const control = register(...args);
        if (++registrations === 2) admitted.resolve();
        return control;
      },
    );
    const f = await advanceFixture({
      yields: ["continue", "user"],
      onGenerate: async (index, request) => {
        if (index !== 0) return;
        started.resolve();
        await release.promise;
        expect(request.signal?.aborted).toBe(false);
      },
    });
    try {
      const older = f.post().then((response) => response.text());
      await started.promise;
      // app.request resolves with stream headers only after admission.
      const newerResponse = await f.post({
        actions: [{ kind: "say", text: "A new arrival" }],
      });
      const newer = newerResponse.text();
      await admitted.promise;
      release.resolve();
      const first = events(await older),
        second = events(await newer);
      expect(
        first.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("new-input");
      expect(
        first.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        second.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(6);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("rejected source spoofing does not invalidate an admitted chain", async () => {
    const started = gate(),
      release = gate();
    const f = await advanceFixture({
      limit: 1,
      onGenerate: async (index) => {
        if (index === 0) {
          started.resolve();
          await release.promise;
        }
      },
    });
    try {
      const result = f.post().then((response) => response.text());
      await started.promise;
      const invalid = await f.post({
        actions: [{ kind: "advance", source: "system" }],
      });
      expect(invalid.status).toBe(400);
      release.resolve();
      expect(
        events(await result).filter(
          (event) => event.type === "execution.started",
        ),
      ).toHaveLength(2);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it.each(["paused", "ended", "replaced", "deleted"])(
    "revalidates a %s session and freezes the cap at root acceptance",
    async (change) => {
      const f = await advanceFixture({ limit: 1 });
      const add = f.store.addTraceEvent.bind(f.store);
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          event.type === "execution.advance" &&
          (event.payload as { phase: string }).phase === "waiting"
        ) {
          const live = (await f.store.getSession(f.sessionId))!;
          if (change === "deleted") await f.store.deleteSession(f.sessionId);
          else
            await f.store.updateSession(f.sessionId, {
              ...(change === "paused" || change === "ended"
                ? { status: change }
                : {}),
              metadata: {
                ...live.metadata,
                autoAdvanceLimit: 10,
                ...(change === "replaced"
                  ? { sessionIncarnationNonce: crypto.randomUUID() }
                  : {}),
              },
            });
        }
      });
      try {
        const stream = events(await (await f.post()).text());
        expect(f.calls()).toBe(1);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload,
        ).toMatchObject({
          reason:
            change === "deleted"
              ? "prerequisite-unavailable"
              : "session-unavailable",
          limit: 1,
        });
        expect(await f.store.queryTurnResults(f.sessionId, {})).toHaveLength(
          change === "deleted" ? 0 : 1,
        );
      } finally {
        await f.close();
      }
    },
  );
});
