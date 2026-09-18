import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as appKv from "../app-kv-store.js";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

vi.mock("../api.js", () => ({ deleteSession: vi.fn(async () => {}) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let vault: BrowserVault;
let secondVault: BrowserVault;
let service: LocalDataService;
let second: LocalDataService;
let sessionId: string;
let otherId: string;

beforeEach(async () => {
  const dbName = `ui-cache-vault-${crypto.randomUUID()}`;
  sessionId = `ui-cache-session-${crypto.randomUUID()}`;
  otherId = `${sessionId}-other`;
  vault = new BrowserVault({ dbName });
  secondVault = new BrowserVault({ dbName });
  for (const id of ["world", "other-world"])
    await vault.upsertWorld({
      id,
      name: id,
      description: "",
      createdAt: "2026-01-01",
    });
  service = new LocalDataService(vault);
  second = new LocalDataService(secondVault);
  await service.createSession("world", undefined, sessionId);
  await second.createSession("other-world", undefined, otherId);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of [sessionId, otherId]) {
    await appKv.removeSubmittedBlocks(id);
    await appKv.removeExecutionSteps(id);
  }
  secondVault.close();
  await vault.deleteDatabase();
});

const kinds = ["form", "timeline"] as const;
function save(target: LocalDataService, kind: (typeof kinds)[number]) {
  return kind === "form"
    ? target.saveSubmittedBlocks(sessionId, ["form"], { form: { score: 7 } })
    : target.saveExecutionSteps(sessionId, [
        { runtimeId: "probe", status: "completed" },
      ]);
}

async function expectEmpty(id: string) {
  expect(await second.loadSubmittedBlocks(id)).toEqual({ ids: [], values: {} });
  expect(await second.loadExecutionSteps(id)).toEqual([]);
}

it.each(["session", "world"])(
  "removes form and timeline caches when deleting a %s and preserves other sessions",
  async (target) => {
    for (const id of [sessionId, otherId]) {
      await service.saveSubmittedBlocks(id, ["form"], { form: { score: 7 } });
      await service.saveExecutionSteps(id, [
        { runtimeId: "probe", status: "completed" },
      ]);
    }
    if (target === "session") await service.deleteSession(sessionId);
    else await service.deleteWorld("world");
    await expectEmpty(sessionId);
    expect(await second.loadSubmittedBlocks(otherId)).toEqual({
      ids: ["form"],
      values: { form: { score: 7 } },
    });
    expect(await second.loadExecutionSteps(otherId)).toEqual([
      { runtimeId: "probe", status: "completed" },
    ]);
  },
);

it.each(kinds)(
  "rejects a late %s save after session deletion",
  async (kind) => {
    await service.deleteSession(sessionId);
    await expect(save(second, kind)).rejects.toThrow("Session not found");
    await expectEmpty(sessionId);
  },
);

it.each(kinds)(
  "rechecks the session after a %s save waits behind deletion",
  async (kind) => {
    const entered = deferred();
    const release = deferred();
    const owner = service.withSessionWorkspace(sessionId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const deletion = second.deleteSession(sessionId);
    const pendingCount = async () =>
      (await navigator.locks.query()).pending?.filter((lock) =>
        lock.name?.includes(sessionId),
      ).length ?? 0;
    let saved = false;
    let pending: Promise<string> | undefined;
    try {
      await vi.waitFor(async () => expect(await pendingCount()).toBe(1));
      pending = save(service, kind).then(
        () => {
          saved = true;
          return "saved";
        },
        (error: Error) => error.message,
      );
      // The baseline can complete without requesting ownership at all.
      await vi.waitFor(async () =>
        expect(saved || (await pendingCount()) === 2).toBe(true),
      );
    } finally {
      release.resolve();
      await Promise.all([owner, deletion]);
    }
    expect(await pending).toBe(`Session not found: ${sessionId}`);
    await expectEmpty(sessionId);
  },
);

it("owns nested form values and timeline entries before waiting for the workspace", async () => {
  const entered = deferred();
  const release = deferred();
  const owner = service.withSessionWorkspace(sessionId, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const ids = ["form"];
  const values = { form: { choice: { score: 7 } } };
  const steps = [{ runtimeId: "probe", status: "running" }];
  const formSave = second.saveSubmittedBlocks(sessionId, ids, values);
  const stepSave = second.saveExecutionSteps(sessionId, steps);
  ids.push("later");
  values.form.choice.score = 99;
  steps[0]!.status = "failed";
  release.resolve();
  await Promise.all([owner, formSave, stepSave]);
  expect(await service.loadSubmittedBlocks(sessionId)).toEqual({
    ids: ["form"],
    values: { form: { choice: { score: 7 } } },
  });
  expect(await service.loadExecutionSteps(sessionId)).toEqual([
    { runtimeId: "probe", status: "running" },
  ]);
});

it("merges form submissions from independent service instances", async () => {
  await Promise.all([
    service.saveSubmittedBlocks(sessionId, ["first"], { first: { score: 1 } }),
    second.saveSubmittedBlocks(sessionId, ["second"], { second: { score: 2 } }),
  ]);
  const stored = await new LocalDataService(secondVault).loadSubmittedBlocks(
    sessionId,
  );
  expect(stored.ids.sort()).toEqual(["first", "second"]);
  expect(stored.values).toEqual({ first: { score: 1 }, second: { score: 2 } });
});

it("holds deletion ownership until timeline cleanup finishes", async () => {
  await save(service, "timeline");
  const entered = deferred();
  const release = deferred();
  const remove = appKv.removeExecutionSteps;
  vi.spyOn(appKv, "removeExecutionSteps").mockImplementationOnce(async (id) => {
    entered.resolve();
    await release.promise;
    await remove(id);
  });
  let deleted = false;
  const deletion = service.deleteSession(sessionId).then(() => {
    deleted = true;
  });
  await entered.promise;
  let late: Promise<string> | undefined;
  try {
    expect(await second.getSession(sessionId)).toBeNull();
    expect(deleted).toBe(false);
    late = save(second, "timeline").then(
      () => "saved",
      (error: Error) => error.message,
    );
    await vi.waitFor(async () => {
      expect(
        (await navigator.locks.query()).pending?.some((lock) =>
          lock.name?.includes(sessionId),
        ),
      ).toBe(true);
    });
  } finally {
    release.resolve();
    await deletion;
  }
  expect(await late).toBe(`Session not found: ${sessionId}`);
  await expectEmpty(sessionId);
});

it("keeps domain deletion successful when cache cleanup fails", async () => {
  await save(service, "form");
  await save(service, "timeline");
  const error = new Error("Synthetic cache cleanup failure");
  vi.spyOn(appKv, "removeExecutionSteps").mockRejectedValueOnce(error);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await service.deleteSession(sessionId);
  expect(await second.getSession(sessionId)).toBeNull();
  expect(await second.loadSubmittedBlocks(sessionId)).toEqual({
    ids: [],
    values: {},
  });
  expect(warning).toHaveBeenCalledWith(expect.any(String), error);
  await expect(save(second, "timeline")).rejects.toThrow("Session not found");
  // A repeated delete can retry best-effort cleanup without recreating the session.
  await second.deleteSession(sessionId);
  await expectEmpty(sessionId);
});
