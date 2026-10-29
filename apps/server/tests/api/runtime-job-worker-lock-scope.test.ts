import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createRuntimeJobWorker,
  type RuntimeJobWorker,
} from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { createRuntimeJob } from "../../src/routes/api/plugin-rpc/jobs.js";

const timestamp = "2026-10-14T00:00:00.000Z";
let store: DataStore;
let worker: RuntimeJobWorker | undefined;

beforeEach(async () => {
  store = createMemoryStore();
  await store.createSession({
    id: "session",
    worldId: "world",
    status: "active",
    locale: "en-US",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["plugin"],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await createRuntimeJob(store, {
    sessionId: "session",
    pluginId: "plugin",
    runtimeId: "plugin/runtime",
    jobId: "job",
    origin: { activation: "stage", sourceTurnId: "turn" },
    payload: {},
    enqueuedAt: timestamp,
  });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await store.close();
});

it("drains outside the lock scope of the request that woke it", async () => {
  const lock = createInProcessSessionLock();
  const probes: boolean[] = [];
  worker = createRuntimeJobWorker({
    store,
    eventBus: createEventBus(),
    tryWithCommitLock: lock.tryWithLock.bind(lock),
    execute: async () => {},
    // Runs inside the drain. A drain that inherited the waking request's
    // async context would reenter the held lock as if it were its owner.
    canExecute: async () => {
      const probe = await lock.tryWithLock("session", async () => true);
      probes.push(probe.acquired);
      return false;
    },
  });
  await lock.withLock("session", async () => {
    worker!.wake("session");
    await vi.waitFor(() => expect(probes.length).toBeGreaterThan(0));
  });
  expect(probes.every((acquired) => !acquired)).toBe(true);
});
