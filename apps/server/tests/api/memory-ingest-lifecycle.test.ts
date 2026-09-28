import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  type DataStore,
} from "@covel/store";
import { awaitPendingMemoryBackgroundTasks } from "@covel/memory";
import { MEMORY_VECTOR_PLUGIN_ID } from "@covel/store/vector";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";

const now = "2026-01-01T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(store: DataStore, id = "session") {
  await store.createSession({
    id,
    status: "active",
    phase: "playing",
    locale: "en",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: ["fake-narrator"],
    metadata: {
      sessionIncarnationNonce: crypto.randomUUID(),
      approvalScopeNonce: "scope",
    },
    createdAt: now,
    updatedAt: now,
  });
}

async function fixture(
  embed = async (texts: readonly string[]) =>
    texts.map(() => new Float32Array([1, 0])),
) {
  const pluginsDir = await mkdtemp(join(tmpdir(), "covel-ingest-"));
  const store = createMemoryStore();
  await seed(store);
  const target = await store.ensureVectorModel!({
    provider: "test",
    modelName: "embed",
    modelId: "test/embed",
    dim: 2,
  });
  const ensureEmbeddingLock = vi.fn(async (id: string) => {
    if (
      (await store.getSession(id)) &&
      !(await store.resolveSessionVectorTarget!(id))
    )
      await store.lockSessionEmbeddingModel!(id, target);
  });
  const loaded = makeFakeLoadedRuntime({
    name: "fake-narrator",
    outputKind: "story",
  });
  const llm = makeFakeLLM("A clue at the harbour").llm;
  const boot = await bootstrapApi({
    pluginsDir,
    perRequestMiddleware: [
      async (c, next) => {
        c.set("loadRuntimeFn", async () => loaded);
        await next();
      },
    ],
    store,
    storeBackend: "memory",
    vectorBackend: "embedded",
    memoryEmbed: embed,
    ensureEmbeddingLock,
    llmAdapter: llm,
  });
  cleanups.push(async () => {
    await closeTestApi(boot);
    await store.close();
    await rm(pluginsDir, { recursive: true, force: true });
  });
  const parsed = {
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  boot.registry.register({
    id: "fake-narrator",
    source: "builtin",
    summary: {
      id: "fake-narrator",
      name: "fake",
      description: "",
      pluginType: "plugin",
      runtimeCount: 1,
    },
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  });
  const action = async (committed = true) => {
    const response = await boot.app.request("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: "session",
        type: "send_message",
        payload: { content: "Visit the harbour" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"committed":${committed}`);
  };
  const vectors = (id = "session") =>
    store.searchVectors!({
      sessionId: id,
      query: new Float32Array([1, 0]),
      topK: 1000,
    });
  return { ...boot, action, vectors, ensureEmbeddingLock, llm };
}

it("automatically ingests committed actions and fully rebuilds a fork beyond one batch", async () => {
  const texts: string[] = [];
  const { app, store, action, vectors, ensureEmbeddingLock } = await fixture(
    async (input) => {
      texts.push(...input);
      return input.map(() => new Float32Array([1, 0]));
    },
  );
  await action();
  await awaitPendingMemoryBackgroundTasks();
  expect((await vectors()).length).toBeGreaterThan(0);
  for (let i = 0; i < 260; i++) {
    await store.appendTurnMessage({
      id: `history-${i.toString().padStart(3, "0")}`,
      sessionId: "session",
      turnId: `t-${i}`,
      sourceType: "player",
      role: "user",
      content: `history ${i}`,
      order: i,
      createdAt: now,
    });
  }
  await store.upsertCharacter({
    id: "hero",
    sessionId: "session",
    name: "Hero",
    type: "npc",
    version: 1,
    fields: {},
    createdAt: now,
    updatedAt: now,
  });
  await store.setPluginData({
    id: "hero-ref",
    sessionId: "session",
    pluginId: "portraits",
    namespace: "characters",
    key: "hero",
    value: { characterId: "hero" },
    createdAt: now,
    updatedAt: now,
  });
  const snapshot = (await (
    await app.request("/api/sessions/session/snapshots", { method: "POST" })
  ).json()) as { id: string };
  texts.length = 0;
  const response = await app.request("/api/sessions/session/fork", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromSnapshotId: snapshot.id }),
  });
  expect(response.status).toBe(201);
  const fork = (await response.json()) as {
    sessionId: string;
    forkSnapshotId: string;
  };
  await awaitPendingMemoryBackgroundTasks();
  expect(ensureEmbeddingLock).toHaveBeenCalledWith(fork.sessionId);
  expect(texts.filter((text) => text.startsWith("history "))).toHaveLength(260);
  expect((await vectors(fork.sessionId)).length).toBeGreaterThan(260);
  expect((await store.listCharacters(fork.sessionId))[0]?.id).toBe("hero");
  expect(
    (
      await store.getPluginData(
        fork.sessionId,
        "portraits",
        "characters",
        "hero",
      )
    )?.value,
  ).toEqual({ characterId: "hero" });
  expect(
    (await store.getSnapshot(fork.forkSnapshotId))?.payload.characters,
  ).toEqual(await store.listCharacters(fork.sessionId));
});

it("waits for delayed ingestion before replacing a checkpoint, then rebuilds only the new corpus", async () => {
  const started = deferred();
  const release = deferred();
  let delay = true;
  const { app, store, action, vectors } = await fixture(async (texts) => {
    if (delay) {
      delay = false;
      started.resolve();
      await release.promise;
    }
    return texts.map(() => new Float32Array([1, 0]));
  });
  await action();
  await started.promise;
  const browser = createMemoryStore();
  await seed(browser);
  await browser.appendTurnMessage({
    id: "replacement",
    sessionId: "session",
    turnId: "new",
    sourceType: "player",
    role: "user",
    content: "new checkpoint corpus",
    order: 0,
    createdAt: now,
  });
  const checkpoint = await exportSessionCheckpoint(browser, "session", {
    revision: 1,
    actionId: "hydrate",
  });
  await browser.close();
  const deleteSession = vi.spyOn(store, "deleteSession");
  const replacing = app.request("/api/sessions/session/browser-checkpoint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkpoint }),
  });
  // Let the route enter its lifecycle/ingestion lock, without timing a provider.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(deleteSession).not.toHaveBeenCalled();
  release.resolve();
  expect((await replacing).status).toBe(200);
  await awaitPendingMemoryBackgroundTasks();
  expect(await vectors()).toHaveLength(1);
  expect((await vectors())[0]?.payload).toContain("new checkpoint corpus");
  const progress = await store.getPluginData(
    "session",
    MEMORY_VECTOR_PLUGIN_ID,
    "recall-ingest",
    "cursor",
  );
  expect(progress?.value).toEqual({ id: "replacement", createdAt: now });
});

it("drains delayed ingestion before delete and leaves same-id recreation without old progress", async () => {
  const started = deferred();
  const release = deferred();
  const { app, store, action } = await fixture(async (texts) => {
    started.resolve();
    await release.promise;
    return texts.map(() => new Float32Array([1, 0]));
  });
  await action();
  await started.promise;
  const deleteSession = vi.spyOn(store, "deleteSession");
  const deleting = app.request("/api/sessions/session", { method: "DELETE" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(deleteSession).not.toHaveBeenCalled();
  release.resolve();
  expect((await deleting).status).toBe(200);
  await seed(store);
  await awaitPendingMemoryBackgroundTasks();
  expect(
    await store.listPluginData("session", MEMORY_VECTOR_PLUGIN_ID),
  ).toEqual([]);
});

it("does not ingest rolled-back story output or advance its cursor", async () => {
  const embed = vi.fn(async (texts: readonly string[]) =>
    texts.map(() => new Float32Array([1, 0])),
  );
  const { store, action, vectors, llm } = await fixture(embed);
  vi.spyOn(llm, "generate").mockRejectedValue(
    new Error("synthetic generation failure"),
  );
  await action(false);
  await awaitPendingMemoryBackgroundTasks();
  expect(embed).not.toHaveBeenCalled();
  expect(await vectors()).toEqual([]);
  expect(
    await store.getPluginData(
      "session",
      MEMORY_VECTOR_PLUGIN_ID,
      "recall-ingest",
      "cursor",
    ),
  ).toBeNull();
});
