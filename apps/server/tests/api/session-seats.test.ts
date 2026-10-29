/**
 * Session seats: the default seat a new session gets, and
 * PATCH /api/sessions/:id/seats/:seatId, which switches the character a human
 * seat acts as.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type { Seat } from "@covel/shared";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const ENV_KEYS = ["DEPLOYMENT_TIER", "COVEL_DESKTOP_REST_TOKEN"] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

const AT = "2026-10-29T00:00:00.000Z";

async function harness(headers: Record<string, string> = {}) {
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", createPluginRegistry());
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  await store.createWorld({
    id: "w1",
    name: "Seat world",
    description: "Synthetic world",
    createdAt: AT,
  });
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ worldId: "w1" }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as {
    id: string;
    ownerToken: string;
    seats: Seat[];
  };
  for (const [id, name, type] of [
    ["ada", "Ada", "player"],
    ["lin", "Lin", "player"],
    ["guide", "Guide", "npc"],
  ] as const)
    await store.upsertCharacter({
      id,
      sessionId: created.id,
      name,
      type,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  return { app, store, created };
}

function patchSeat(
  app: Hono,
  sessionId: string,
  seatId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/sessions/${sessionId}/seats/${seatId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function setSeats(store: DataStore, sessionId: string, seats: Seat[]) {
  await store.updateSession(sessionId, { seats, updatedAt: AT });
}

describe("session seats", () => {
  it("gives a new session one human player seat that binds every player character", async () => {
    const { store, created } = await harness();
    const expected = [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ];
    expect(created.seats).toEqual(expected);
    expect((await store.getSession(created.id))?.seats).toEqual(expected);
  });

  it("switches the current character of a human seat", async () => {
    const { app, store, created } = await harness();
    const res = await patchSeat(app, created.id, "main", {
      currentCharacterId: "lin",
    });
    expect(res.status).toBe(200);
    const expected = [
      {
        id: "main",
        controller: "human",
        role: "player",
        characters: "auto",
        currentCharacterId: "lin",
      },
    ];
    expect(await res.json()).toEqual({ seats: expected });
    expect((await store.getSession(created.id))?.seats).toEqual(expected);
  });

  it("answers 404 for an unknown session or seat", async () => {
    const { app, created } = await harness();
    const unknownSession = await patchSeat(app, "nope", "main", {
      currentCharacterId: "lin",
    });
    expect(unknownSession.status).toBe(404);
    const unknownSeat = await patchSeat(app, created.id, "nope", {
      currentCharacterId: "lin",
    });
    expect(unknownSeat.status).toBe(404);
    expect(await unknownSeat.json()).toMatchObject({ code: "seat_not_found" });
  });

  it.each([
    ["an NPC the auto seat does not bind", "guide"],
    ["a character that does not exist", "ghost"],
  ])("answers 409 seat_character_unbound for %s", async (_label, id) => {
    const { app, store, created } = await harness();
    const res = await patchSeat(app, created.id, "main", {
      currentCharacterId: id,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "seat_character_unbound" });
    expect(
      (await store.getSession(created.id))?.seats[0]?.currentCharacterId,
    ).toBeUndefined();
  });

  it("answers 409 seat_character_unbound for a character another seat lists", async () => {
    const { app, created, store } = await harness();
    await setSeats(store, created.id, [
      { id: "main", controller: "human", role: "player", characters: "auto" },
      {
        id: "second",
        controller: "human",
        role: "player",
        characters: ["lin"],
      },
    ]);
    const res = await patchSeat(app, created.id, "main", {
      currentCharacterId: "lin",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "seat_character_unbound" });
    const second = await patchSeat(app, created.id, "second", {
      currentCharacterId: "lin",
    });
    expect(second.status).toBe(200);
  });

  it("answers 409 seat_not_human for an empty seat", async () => {
    const { app, created, store } = await harness();
    await setSeats(store, created.id, [
      { id: "main", controller: "human", role: "player", characters: "auto" },
      { id: "open", controller: "empty", role: "player", characters: ["lin"] },
    ]);
    const res = await patchSeat(app, created.id, "open", {
      currentCharacterId: "lin",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "seat_not_human" });
  });

  it("rejects a body that is not { currentCharacterId }", async () => {
    const { app, created } = await harness();
    for (const body of [
      {},
      { currentCharacterId: "" },
      { currentCharacterId: "lin", extra: 1 },
    ]) {
      const res = await patchSeat(app, created.id, "main", body);
      expect(res.status).toBe(400);
    }
  });

  describe("on a hosted profile", () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_TIER = "commercial";
      process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    });

    it("requires the session's owner token", async () => {
      const { app, created, store } = await harness({
        authorization: "Bearer operator-secret",
      });
      const body = { currentCharacterId: "lin" };
      expect((await patchSeat(app, created.id, "main", body)).status).toBe(401);
      expect(
        (
          await patchSeat(app, created.id, "main", body, {
            authorization: "Bearer wrong-token",
          })
        ).status,
      ).toBe(401);
      expect(
        (await store.getSession(created.id))?.seats[0]?.currentCharacterId,
      ).toBeUndefined();
      expect(
        (
          await patchSeat(app, created.id, "main", body, {
            authorization: `Bearer ${created.ownerToken}`,
          })
        ).status,
      ).toBe(200);
    });
  });
});
