// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@/services/api.js";
import {
  latestPlayableSession,
  mostRecentSession,
  recentSessionsByWorld,
} from "../use-recent-sessions.js";

function session(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    worldId: "world-a",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as SessionRecord;
}

describe("recent sessions", () => {
  it("picks the most recently touched session that can still be played", () => {
    const sessions = [
      session("old", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      session("ended", {
        status: "ended",
        updatedAt: "2026-01-09T00:00:00.000Z",
      }),
      session("paused", {
        status: "paused",
        updatedAt: "2026-01-05T00:00:00.000Z",
      }),
      // Never updated: its creation time is when it was last touched.
      session("fresh", { createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    expect(latestPlayableSession(sessions)?.id).toBe("paused");
    expect(
      latestPlayableSession([session("ended", { status: "ended" })]),
    ).toBeUndefined();
  });

  it("groups one listing by world and ignores worlds that are not listed", () => {
    const recent = recentSessionsByWorld(
      [
        session("a-old", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        session("a-new", { updatedAt: "2026-01-06T00:00:00.000Z" }),
        session("b-ended", { worldId: "world-b", status: "ended" }),
        session("gone", { worldId: "world-deleted" }),
      ],
      ["world-a", "world-b"],
    );
    expect([...recent.keys()]).toEqual(["world-a"]);
    expect(recent.get("world-a")?.id).toBe("a-new");
  });

  it("offers one session across all worlds", () => {
    const recent = new Map([
      ["world-a", session("a", { updatedAt: "2026-01-02T00:00:00.000Z" })],
      [
        "world-b",
        session("b", {
          worldId: "world-b",
          updatedAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
    ]);
    expect(mostRecentSession(recent)?.id).toBe("b");
    expect(mostRecentSession(new Map())).toBeUndefined();
  });
});
