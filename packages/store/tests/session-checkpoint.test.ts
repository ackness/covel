import { describe, expect, it } from "vitest";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/index.js";
import { createMemoryStore } from "../src/memory-entry.js";

import {
  makeCharacter,
  makeEvent,
  makeMessage,
  makeLorebookEntry,
  makeRuntimeExport,
  makeRuntimeOutput,
  makeSession,
  makeToolCall,
  makeTurnMessage,
  makeTurnResult,
  makeTraceEvent,
  makeWorld,
} from "../src/contract/test-fixtures.js";

describe("session checkpoint transfer", () => {
  it("keeps recovery records without copying model diagnostics into a private checkpoint", async () => {
    const store = createMemoryStore();
    const session = makeSession();
    await store.createSession(session);
    const payload = {
      request: { messages: [{ content: "x".repeat(1_000_000) }] },
    };
    await store.addTraceEvent(
      makeTraceEvent({ sessionId: session.id, type: "llm.calling", payload }),
    );
    await store.saveEvent(
      makeEvent({ sessionId: session.id, topic: "trace", payload }),
    );
    await store.addTraceEvent(
      makeTraceEvent({
        sessionId: session.id,
        id: "recovery",
        type: "turn.started",
        payload: { recoveryAction: { type: "send_message" } },
      }),
    );
    const checkpoint = await exportSessionCheckpoint(store, session.id, {
      revision: 1,
      actionId: "test",
    });
    expect(checkpoint.traceEvents.map((event) => event.id)).toEqual([
      "recovery",
    ]);
    expect(checkpoint.events).toEqual([]);
    expect(JSON.stringify(checkpoint).length).toBeLessThan(10_000);
    expect(await store.listTraceEvents(session.id)).toHaveLength(2);
  });
  it("keeps the journals of the latest executions and all of the conversation", async () => {
    const store = createMemoryStore();
    const session = makeSession();
    await store.createSession(session);
    const turns = 60;
    for (let turn = 0; turn < turns; turn += 1) {
      const turnId = `turn-${turn}`;
      const createdAt = new Date(Date.UTC(2026, 9, 7, 0, turn)).toISOString();
      const at = { sessionId: session.id, turnId, createdAt };
      await store.addMessage(
        makeMessage({
          sessionId: session.id,
          id: `message-${turn}`,
          createdAt,
        }),
      );
      await store.appendTurnMessage(
        makeTurnMessage({ ...at, id: `turn-message-${turn}` }),
      );
      await store.saveTurnResult(
        makeTurnResult({ ...at, id: `result-${turn}` }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({
          ...at,
          id: `output-${turn}`,
          timestamp: createdAt,
        }),
      );
      await store.saveToolCall(makeToolCall({ ...at, id: `call-${turn}` }));
      await store.saveEvent(makeEvent({ ...at, id: `event-${turn}` }));
      for (const type of [
        "turn.started",
        "runtime.completed",
        "turn.completed",
      ])
        await store.addTraceEvent(
          makeTraceEvent({ ...at, id: `${type}-${turn}`, type }),
        );
    }
    const checkpoint = await exportSessionCheckpoint(store, session.id, {
      revision: 1,
      actionId: "test",
    });
    // What a later turn reads is whole.
    expect(checkpoint.messages).toHaveLength(turns);
    expect(checkpoint.turnMessages).toHaveLength(turns);
    // The status of every execution can still be read.
    expect(checkpoint.traceEvents.map((event) => event.type).sort()).toEqual([
      ...Array.from({ length: turns }, () => "turn.completed"),
      ...Array.from({ length: turns }, () => "turn.started"),
    ]);
    // Results and outputs are those of the latest executions.
    expect(checkpoint.turnResults).toHaveLength(40);
    expect(checkpoint.turnResults.at(-1)?.turnId).toBe(`turn-${turns - 1}`);
    expect(checkpoint.runtimeOutputs.map((output) => output.turnId)).toEqual(
      expect.arrayContaining(["turn-20", `turn-${turns - 1}`]),
    );
    expect(checkpoint.runtimeOutputs).toHaveLength(40);
    // Logs that nothing reads stay behind.
    expect(checkpoint.toolCalls).toEqual([]);
    expect(checkpoint.events).toEqual([]);
  });

  it("carries only the newest revision of each runtime export", async () => {
    const store = createMemoryStore();
    const session = makeSession();
    await store.createSession(session);
    for (const revision of [1, 2, 3]) {
      await store.appendRuntimeExport(
        makeRuntimeExport({
          sessionId: session.id,
          recordAs: "world.facts",
          revision,
          value: { revision },
        }),
      );
    }
    await store.appendRuntimeExport(
      makeRuntimeExport({
        sessionId: session.id,
        recordAs: "quest.log",
        revision: 1,
        value: { revision: 1 },
      }),
    );
    const checkpoint = await exportSessionCheckpoint(store, session.id, {
      revision: 1,
      actionId: "test",
    });
    expect(
      checkpoint.runtimeExports
        .map((record) => `${record.recordAs}@${record.revision}`)
        .sort(),
    ).toEqual(["quest.log@1", "world.facts@3"]);
  });

  it("exports and atomically restores durable session domains", async () => {
    const source = createMemoryStore();
    const target = createMemoryStore();
    const sessionId = "browser-session";
    const world = makeWorld({ id: "browser-world" });
    const session = makeSession({ id: sessionId, worldId: world.id });

    await source.upsertWorld(world);
    await source.createSession(session);
    await source.addMessage(makeMessage({ sessionId, id: "message-1" }));
    await source.appendTurnMessage(
      makeTurnMessage({ sessionId, id: "turn-message-1" }),
    );
    await source.saveEvent(makeEvent({ sessionId, id: "event-1" }));
    await source.upsertCharacter(
      makeCharacter({ sessionId, id: "character-1" }),
    );
    await source.upsertCharacterSchema({
      sessionId,
      version: 2,
      types: ["enemy"],
      attributes: [],
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    await source.upsertLorebookEntries([
      makeLorebookEntry({ sessionId, id: "same", owner: { kind: "world" } }),
      makeLorebookEntry({
        sessionId,
        id: "same",
        owner: { kind: "plugin", pluginId: "writer" },
      }),
    ]);
    await source.setPluginData({
      id: "plugin-data-1",
      sessionId,
      pluginId: "test-plugin",
      namespace: "test",
      key: "value",
      value: { ok: true },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });

    const checkpoint = await exportSessionCheckpoint(source, sessionId, {
      revision: 1,
      actionId: "bootstrap",
      committedAt: "2026-08-25T00:00:00.000Z",
    });
    await replaceSessionFromCheckpoint(target, checkpoint, {
      writeWorld: true,
    });

    expect(await target.getSession(sessionId)).toEqual(session);
    expect(await target.getWorld(world.id)).toEqual(world);
    expect(await target.listMessages(sessionId)).toEqual(checkpoint.messages);
    expect(await target.listTurnMessages(sessionId)).toEqual(
      checkpoint.turnMessages,
    );
    expect(await target.listEvents(sessionId)).toEqual(checkpoint.events);
    expect(await target.listCharacters(sessionId)).toEqual(
      checkpoint.characters,
    );
    expect(await target.getCharacterSchema(sessionId)).toEqual(
      checkpoint.characterSchema,
    );
    expect(await target.listSessionLorebookEntries(sessionId)).toEqual(
      checkpoint.lorebookEntries,
    );
    expect(await target.listPluginDataSessionScope(sessionId)).toEqual(
      checkpoint.pluginData,
    );
  });

  it("allows the server to preserve private session metadata", async () => {
    const source = createMemoryStore();
    const target = createMemoryStore();
    const session = makeSession({ id: "browser-session", metadata: { ui: 1 } });
    await source.createSession(session);
    await target.createSession(
      makeSession({
        id: session.id,
        metadata: { ownerTokenHash: "server-private" },
      }),
    );
    const checkpoint = await exportSessionCheckpoint(source, session.id, {
      revision: 1,
      actionId: "bootstrap",
    });

    await replaceSessionFromCheckpoint(target, checkpoint, {
      session: {
        ...checkpoint.session,
        metadata: {
          ...checkpoint.session.metadata,
          ...(await target.getSession(session.id))?.metadata,
        },
      },
    });

    expect((await target.getSession(session.id))?.metadata).toEqual({
      ui: 1,
      ownerTokenHash: "server-private",
    });
  });

  it("preserves shared worlds unless world writes are explicitly authorized", async () => {
    const source = createMemoryStore();
    const target = createMemoryStore();
    const world = makeWorld({ id: "shared-world", name: "Shared world" });
    const session = makeSession({ id: "browser-session", worldId: world.id });
    await target.upsertWorld(world);
    await source.upsertWorld({ ...world, name: "Browser edit" });
    await source.createSession(session);
    const checkpoint = await exportSessionCheckpoint(source, session.id, {
      revision: 1,
      actionId: "bootstrap",
    });

    await replaceSessionFromCheckpoint(target, checkpoint);

    expect(await target.getWorld(world.id)).toEqual(world);
    expect(await target.getSession(session.id)).toEqual(session);
  });
});
