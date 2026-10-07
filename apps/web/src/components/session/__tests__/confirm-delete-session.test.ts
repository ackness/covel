// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import i18n from "@/i18n/index.js";
import {
  subscribeConfirm,
  type PendingConfirm,
} from "@/lib/confirm-channel.js";
import type { SessionRecord } from "@/services/api.js";
import { confirmDeleteSession } from "../confirm-delete-session.js";

const session = {
  id: "0b6f0c1e-6f0e-4d53-9a51-0d7d0a8f3c11",
  worldId: "lantern-barrow",
  completedPlayerTurns: 3,
  createdAt: "2026-10-05T14:30:00.000Z",
} as SessionRecord;

let seen: PendingConfirm[];
let unsubscribe: () => void;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  seen = [];
  unsubscribe = subscribeConfirm((pending) => seen.push(pending));
});
afterEach(() => unsubscribe());

it("names a save by world, turn and start time instead of its id", async () => {
  const answer = confirmDeleteSession(
    i18n.t,
    "en-US",
    session,
    "Lantern Barrow",
  );

  const request = seen[0]!;
  expect(request.subject).toBe(
    `Lantern Barrow · Turn 3 · ${new Date(session.createdAt).toLocaleString("en-US")}`,
  );
  expect(`${request.message}${request.subject}`).not.toContain(session.id);
  expect(request.destructive).toBe(true);

  request.resolve(true);
  await expect(answer).resolves.toBe(true);
});
