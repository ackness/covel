import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_ACTION_KINDS, type Seat } from "@covel/shared";
import type { SessionActionKindsResponse } from "@covel/shared";
import { advanceFixture } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("session creation role", () => {
  it("gives an in-game host neither operator access nor another session's ownership", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    const f = await advanceFixture();
    try {
      const response = await f.boot.app.request("/api/sessions", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ seatRole: "host", plugins: [] }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()) as {
        id: string;
        ownerToken: string;
      };
      const ownHeaders = {
        "content-type": "application/json",
        "x-session-token": created.ownerToken,
      };
      expect(
        (
          await f.boot.app.request(`/api/sessions/${created.id}`, {
            headers: ownHeaders,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.boot.app.request(`/api/sessions/${f.sessionId}`, {
            headers: ownHeaders,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.boot.app.request("/api/sessions", {
            method: "POST",
            headers: ownHeaders,
            body: JSON.stringify({ seatRole: "host", plugins: [] }),
          })
        ).status,
      ).toBe(401);
      const before = await f.store.getSession(created.id);
      const duplicate = await f.boot.app.request("/api/sessions", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({
          id: created.id,
          seatRole: "spectator",
          plugins: [],
        }),
      });
      expect(duplicate.status).toBe(409);
      expect(await f.store.getSession(created.id)).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it.each([undefined, "player", "host", "spectator"] as const)(
    "creates and persists the selected %s seat through the public endpoint",
    async (seatRole) => {
      const f = await advanceFixture();
      try {
        const response = await f.boot.app.request("/api/sessions", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ plugins: [], seatRole, autoAdvanceLimit: 2 }),
        });
        expect(response.status).toBe(201);
        const created = (await response.json()) as {
          id: string;
          seats: Seat[];
        };
        const role = seatRole ?? "player";
        expect(created.seats).toEqual([
          {
            id: "main",
            controller: "human",
            role,
            characters: role === "player" ? "auto" : [],
          },
        ]);
        expect((await f.store.getSession(created.id))?.seats).toEqual(
          created.seats,
        );
        const reload = await f.boot.app.request(`/api/sessions/${created.id}`, {
          headers: f.headers,
        });
        expect(await reload.json()).toMatchObject({
          seats: created.seats,
          autoAdvanceLimit: 2,
        });
        const catalogue = await f.boot.app.request(
          `/api/sessions/${created.id}/action-kinds`,
          { headers: f.headers },
        );
        expect(catalogue.status).toBe(200);
        expect(
          ((await catalogue.json()) as SessionActionKindsResponse).seats,
        ).toEqual([
          {
            seatId: "main",
            role,
            controller: "human",
            allowed: ROLE_ACTION_KINDS[role],
          },
        ]);
        if (role === "host")
          expect(ROLE_ACTION_KINDS[role]).toEqual([
            "narrate",
            "direct",
            "advance",
            "command",
          ]);
        if (role === "spectator")
          expect(ROLE_ACTION_KINDS[role]).toEqual(["advance"]);
        const snapshot = await f.boot.app.request(
          `/api/sessions/${created.id}/snapshots`,
          { method: "POST", headers: f.headers },
        );
        expect(snapshot.status).toBe(201);
        const saved = (await snapshot.json()) as {
          id: string;
          payload: { session: { seats: Seat[] } };
        };
        expect(saved.payload.session.seats).toEqual(created.seats);
        const fork = await f.boot.app.request(
          `/api/sessions/${created.id}/fork`,
          {
            method: "POST",
            headers: f.headers,
            body: JSON.stringify({ fromSnapshotId: saved.id }),
          },
        );
        expect(fork.status).toBe(201);
        const child = (await fork.json()) as { sessionId: string };
        expect((await f.store.getSession(child.sessionId))?.seats).toEqual(
          created.seats,
        );
      } finally {
        await f.close();
      }
    },
  );
  it.each(["operator", "system", "HOST", "", 1, null, {}, ["host"]])(
    "rejects malformed role %j without creating a session",
    async (seatRole) => {
      const f = await advanceFixture();
      try {
        const before = await f.store.listSessions();
        const response = await f.boot.app.request("/api/sessions", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ seatRole, plugins: [] }),
        });
        expect(response.status).toBe(400);
        expect(await f.store.listSessions()).toEqual(before);
      } finally {
        await f.close();
      }
    },
  );
  it("keeps host-profile authorization and world/locale validation before creation", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    const f = await advanceFixture();
    try {
      const before = await f.store.listSessions();
      const denied = await f.boot.app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatRole: "host", plugins: [] }),
      });
      expect(denied.status).toBe(401);
      for (const body of [
        { worldId: "missing-world", seatRole: "host" },
        { locale: 42, seatRole: "spectator" },
      ]) {
        const response = await f.boot.app.request("/api/sessions", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify(body),
        });
        expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(
          400,
        );
      }
      expect(await f.store.listSessions()).toEqual(before);
    } finally {
      await f.close();
    }
  });
});
