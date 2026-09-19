import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSessionCredentialFixtures } from "../../test/session-credentials.js";
import { deleteWorld } from "../api/worlds.js";
import { createSession } from "../api/sessions.js";
import * as credentials from "../session-credentials.js";
import Dexie from "dexie";
import { getSessionToken, storeSessionToken } from "../session-credentials.js";

beforeEach(clearSessionCredentialFixtures);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([200, 409, 404])(
  "cleans confirmed missing credentials after world deletion returns %i",
  async (status) => {
    await storeSessionToken("removed", "synthetic-removed");
    await storeSessionToken("remaining", "synthetic-remaining");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/worlds/world")
        return Response.json(
          status === 200 ? { ok: true } : { error: "Synthetic delete failure" },
          { status },
        );
      if (url === "/api/sessions/removed")
        return Response.json(
          { error: "Missing", code: "session_not_found" },
          { status: 404 },
        );
      if (url === "/api/sessions/remaining")
        return Response.json({ id: "remaining" });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = deleteWorld("world");
    if (status === 200) await result;
    else await expect(result).rejects.toMatchObject({ status });
    expect(await getSessionToken("removed")).toBeUndefined();
    expect(await getSessionToken("remaining")).toBe("synthetic-remaining");
  },
);

it.each([
  [401, "session_owner_required"],
  [500, "internal_error"],
  [404, "route_not_found"],
  [404, undefined],
] as const)(
  "preserves unverifiable credentials on %i/%s",
  async (status, code) => {
    await storeSessionToken("session", "synthetic-owner");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json(
          { error: "synthetic-private-response", code },
          { status },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await deleteWorld("world");
    expect(await getSessionToken("session")).toBe("synthetic-owner");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).not.toContain(
      "synthetic-private-response",
    );
    expect(String(warn.mock.calls[0])).not.toContain("synthetic-owner");
  },
);

it("uses captured credentials and preserves replacements during delayed verification", async () => {
  await storeSessionToken("same-id", "synthetic-old");
  const list = credentials.listSessionCredentials;
  vi.spyOn(credentials, "listSessionCredentials").mockImplementationOnce(
    async () => {
      const captured = await list();
      await storeSessionToken("same-id", "synthetic-new");
      return captured;
    },
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(
      Response.json(
        { error: "Missing", code: "session_not_found" },
        { status: 404 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  await deleteWorld("world");
  expect(
    new Headers(fetchMock.mock.calls[1][1].headers).get("X-Session-Token"),
  ).toBe("synthetic-old");
  expect(await getSessionToken("same-id")).toBe("synthetic-new");
});

it("preserves the original delete error when credential storage fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(credentials, "listSessionCredentials").mockRejectedValueOnce(
    new Error("Synthetic storage unavailable"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: "Synthetic delete failure",
          code: "world_delete_incomplete",
        },
        { status: 409 },
      ),
    ),
  );
  await expect(deleteWorld("world")).rejects.toMatchObject({
    status: 409,
    code: "world_delete_incomplete",
  });
  expect(warn).toHaveBeenCalledOnce();
});

it("retries failed local cleanup on a later deletion attempt", async () => {
  await storeSessionToken("removed", "synthetic-owner");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Dexie.prototype, "transaction").mockRejectedValueOnce(
    new DOMException("Synthetic abort", "AbortError"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.startsWith("/api/worlds/")
          ? { ok: true }
          : { error: "Missing", code: "session_not_found" },
        { status: url.startsWith("/api/worlds/") ? 200 : 404 },
      ),
    ),
  );
  await deleteWorld("world");
  expect(await getSessionToken("removed")).toBe("synthetic-owner");
  await deleteWorld("world");
  expect(await getSessionToken("removed")).toBeUndefined();
});

it("bounds all verification requests without retrying and preserves successful deletion", async () => {
  await storeSessionToken("one", "synthetic-one");
  await storeSessionToken("two", "synthetic-two");
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    if (url.startsWith("/api/worlds/")) return Response.json({ ok: true });
    return new Promise<Response>((_resolve, reject) => {
      const signal = options.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      if (signals.length === 2) notify();
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const pending = deleteWorld("world");
  await entered;
  controller.abort();
  await pending;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(await getSessionToken("one")).toBe("synthetic-one");
  expect(await getSessionToken("two")).toBe("synthetic-two");
});

it("does not restore a credential when creation completes after world cleanup", async () => {
  let reply!: (response: Response) => void;
  let notify!: () => void;
  const created = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === "POST") {
        notify();
        return created;
      }
      if (url.startsWith("/api/worlds/")) return Response.json({ ok: true });
      return Response.json(
        { error: "Missing", code: "session_not_found" },
        { status: 404 },
      );
    }),
  );
  const pending = createSession("world", "session");
  const rejected = expect(pending).rejects.toThrow(
    "Created session is no longer current",
  );
  await entered;
  await deleteWorld("world");
  reply(
    Response.json({
      id: "session",
      ownerToken: "synthetic-owner",
      incarnation: "old",
    }),
  );
  await rejected;
  expect(await getSessionToken("session")).toBeUndefined();
});

it("rejects an obsolete creation without clearing a replacement credential", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: "session",
          ownerToken: "synthetic-old",
          incarnation: "old",
        }),
      )
      .mockImplementationOnce(async (_url: string, options: RequestInit) => {
        expect(new Headers(options.headers).get("X-Session-Token")).toBe(
          "synthetic-old",
        );
        await storeSessionToken("session", "synthetic-new");
        return Response.json({ id: "session", incarnation: "new" });
      }),
  );
  await expect(createSession("world", "session")).rejects.toThrow(
    "Created session is no longer current",
  );
  expect(await getSessionToken("session")).toBe("synthetic-new");
});

it.each([
  [401, { error: "synthetic-private" }],
  [500, { error: "synthetic-private" }],
  [404, { error: "synthetic-private", code: "route_not_found" }],
  [200, { id: "different-session", incarnation: "new" }],
  [200, { id: "session" }],
] as const)(
  "retains a successful creation when verification is inconclusive (%i)",
  async (status, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: "session",
          ownerToken: "synthetic-owner",
          incarnation: "old",
        }),
      )
      .mockResolvedValueOnce(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSession("world", "session")).resolves.toEqual({
      id: "session",
      incarnation: "old",
    });
    expect(await getSessionToken("session")).toBe("synthetic-owner");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).not.toContain("synthetic-private");
  },
);

it("reports obsolete creation even when credential cleanup fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: "session",
          ownerToken: "synthetic-owner",
          incarnation: "old",
        }),
      )
      .mockImplementationOnce(async () => {
        vi.spyOn(Dexie.prototype, "transaction").mockRejectedValueOnce(
          new Error("Synthetic abort"),
        );
        return Response.json(
          { error: "Missing", code: "session_not_found" },
          { status: 404 },
        );
      }),
  );
  await expect(createSession("world", "session")).rejects.toThrow(
    "Created session is no longer current",
  );
  expect(await getSessionToken("session")).toBe("synthetic-owner");
});

it("requires the current creation incarnation before saving credentials", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "session", ownerToken: "synthetic-owner" }),
      ),
  );
  await expect(createSession("world", "session")).rejects.toThrow(
    "Created session is missing its incarnation",
  );
  expect(await getSessionToken("session")).toBeUndefined();
});
