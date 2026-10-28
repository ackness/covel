import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodePageCursor, type PageCursor } from "@covel/shared";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

const api = await vi.hoisted(async () => {
  const { fakeSessionServer } =
    await import("./support/fake-session-server.js");
  return fakeSessionServer();
});
vi.mock("../api.js", () => api);

const at = "2026-10-14T00:00:00.000Z";
const earlier = "2026-10-13T00:00:00.000Z";
let vault: BrowserVault;
let service: LocalDataService;

beforeEach(async () => {
  vault = new BrowserVault({ dbName: `message-order-${crypto.randomUUID()}` });
  service = new LocalDataService(vault);
  await vault.upsertWorld({
    id: "world",
    name: "World",
    description: "",
    createdAt: at,
  });
  await service.createSession("world", "session");
  // Backfill an earlier timestamp amid ties, whose IDs oppose write order.
  for (const [id, createdAt] of [
    ["z-story", at],
    ["old", earlier],
    ["b-card", at],
    ["a-story", at],
    ["m-card", at],
  ] as const) {
    await service.addMessage({
      id,
      sessionId: "session",
      role: "assistant",
      content: id,
      createdAt,
    });
  }
});

afterEach(() => vault.deleteDatabase());

it("pages tied timestamps in checkpoint write order without omissions or duplicates after reload", async () => {
  service = new LocalDataService(vault);
  const all = await service.listMessages("session");
  expect(all.map((row) => row.id)).toEqual([
    "old",
    "z-story",
    "b-card",
    "a-story",
    "m-card",
  ]);
  const pages: string[][] = [];
  let cursor: PageCursor | undefined;
  do {
    const page = await service.listMessagesPage("session", {
      limit: 2,
      cursor,
    });
    pages.push(page.items.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages.length < 5);
  expect(pages).toEqual([
    ["a-story", "m-card"],
    ["z-story", "b-card"],
    ["old"],
  ]);
  expect(pages.reverse().flat()).toEqual(all.map((row) => row.id));
});

it.each(["missing", "old"])(
  "a cursor without a matching timestamp and ID excludes that entire timestamp group (%s)",
  async (id) => {
    const page = await service.listMessagesPage("session", {
      limit: 10,
      cursor: encodePageCursor({ createdAt: at, id }),
    });
    expect(page.items.map((row) => row.id)).toEqual(["old"]);
    expect(page.nextCursor).toBeNull();
  },
);
