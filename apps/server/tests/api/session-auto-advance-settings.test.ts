import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFixture, events } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("session advancement settings", () => {
  it.each([-1, 11, 1.5, "3", null])(
    "rejects %j at create and PATCH",
    async (autoAdvanceLimit) => {
      const f = await advanceFixture();
      try {
        const created = await f.boot.app.request("/api/sessions", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ autoAdvanceLimit }),
        });
        const updated = await f.boot.app.request(
          `/api/sessions/${f.sessionId}`,
          {
            method: "PATCH",
            headers: f.headers,
            body: JSON.stringify({ autoAdvanceLimit }),
          },
        );
        expect(created.status).toBe(400);
        expect(updated.status).toBe(400);
        expect(
          (await f.store.getSession(f.sessionId))?.metadata?.autoAdvanceLimit,
        ).toBeUndefined();
      } finally {
        await f.close();
      }
    },
  );
  it("creates, patches and forks the typed setting without losing other metadata", async () => {
    const f = await advanceFixture();
    try {
      const created = await f.boot.app.request("/api/sessions", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ plugins: [], autoAdvanceLimit: 7 }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ autoAdvanceLimit: 7 });
      const before = await f.store.getSession(f.sessionId);
      const get = await f.boot.app.request(`/api/sessions/${f.sessionId}`, {
        headers: f.headers,
      });
      expect(await get.json()).toMatchObject({ autoAdvanceLimit: 3 });
      const patch = await f.boot.app.request(`/api/sessions/${f.sessionId}`, {
        method: "PATCH",
        headers: f.headers,
        body: JSON.stringify({ autoAdvanceLimit: 8 }),
      });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({ autoAdvanceLimit: 8 });
      expect((await f.store.getSession(f.sessionId))?.metadata).toMatchObject({
        ...before?.metadata,
        autoAdvanceLimit: 8,
      });
      const snapshot = await f.boot.app.request(
        `/api/sessions/${f.sessionId}/snapshots`,
        { method: "POST", headers: f.headers },
      );
      expect(snapshot.status).toBe(201);
      const saved = await snapshot.json();
      expect(saved.payload.session.autoAdvanceLimit).toBe(8);
      const fork = await f.boot.app.request(
        `/api/sessions/${f.sessionId}/fork`,
        {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ fromSnapshotId: saved.id }),
        },
      );
      expect(fork.status).toBe(201);
      const child = await fork.json();
      expect(
        (await f.store.getSession(child.sessionId))?.metadata?.autoAdvanceLimit,
      ).toBe(8);
      expect(JSON.stringify(saved.payload.session)).not.toContain("rootId");
    } finally {
      await f.close();
    }
  });
  it("uses a changed cap only on the next input", async () => {
    const f = await advanceFixture({ limit: 1 });
    const add = f.store.addTraceEvent.bind(f.store);
    let changed = false;
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      if (
        !changed &&
        event.type === "execution.advance" &&
        (event.payload as { phase: string }).phase === "waiting"
      ) {
        changed = true;
        const patch = await f.boot.app.request(`/api/sessions/${f.sessionId}`, {
          method: "PATCH",
          headers: f.headers,
          body: JSON.stringify({ autoAdvanceLimit: 0 }),
        });
        expect(patch.status).toBe(200);
      }
    });
    try {
      const first = events(await (await f.post()).text());
      expect(
        first.filter((event) => event.type === "execution.started"),
      ).toHaveLength(2);
      const next = events(await (await f.post()).text());
      expect(
        next.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        next.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("disabled");
    } finally {
      await f.close();
    }
  });
});
