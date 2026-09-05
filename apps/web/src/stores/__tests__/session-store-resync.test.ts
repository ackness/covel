/**
 * Staleness guard on the post-turn SessionRecord resync: a getSession
 * response that lands after the player has switched sessions must be
 * dropped, not dispatched — otherwise state.session points at the
 * abandoned session while messages/gameState belong to the active one.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, getSession: vi.fn() };
});

import * as api from "@/services/api";
import { resyncSessionRecord } from "../session-store/actions.js";

const SESSION = { id: "sess-1" } as api.SessionRecord;

describe("resyncSessionRecord", () => {
  it("dispatches SET_SESSION while the session is still active", async () => {
    vi.mocked(api.getSession).mockResolvedValue(SESSION);
    const dispatch = vi.fn();

    await resyncSessionRecord("sess-1", { current: "sess-1" }, dispatch, {
      current: 0,
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SESSION",
      session: SESSION,
    });
  });

  it("drops a stale response after a session switch", async () => {
    vi.mocked(api.getSession).mockResolvedValue(SESSION);
    const dispatch = vi.fn();

    await resyncSessionRecord("sess-1", { current: "sess-2" }, dispatch, {
      current: 0,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops a stale response after leaving the session entirely", async () => {
    vi.mocked(api.getSession).mockResolvedValue(SESSION);
    const dispatch = vi.fn();

    await resyncSessionRecord("sess-1", { current: null }, dispatch, {
      current: 0,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("swallows fetch errors — next action or reload will resync", async () => {
    vi.mocked(api.getSession).mockRejectedValue(new Error("boom"));
    const dispatch = vi.fn();

    await expect(
      resyncSessionRecord("sess-1", { current: "sess-1" }, dispatch, {
        current: 0,
      }),
    ).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops metadata from a previous visit to the same session id", async () => {
    let resolveSession!: (session: api.SessionRecord) => void;
    vi.mocked(api.getSession).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const dispatch = vi.fn();
    const sessionIdRef = { current: "sess-1" as string | null };
    const sessionGenerationRef = { current: 1 };
    const syncing = resyncSessionRecord(
      "sess-1",
      sessionIdRef,
      dispatch,
      sessionGenerationRef,
    );
    sessionIdRef.current = null;
    sessionGenerationRef.current += 1;
    sessionIdRef.current = "sess-1";
    sessionGenerationRef.current += 1;
    resolveSession(SESSION);
    await syncing;
    expect(dispatch).not.toHaveBeenCalled();
  });
});
