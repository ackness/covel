import { describe, expect, it } from "vitest";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/index.js";
import {
  makeCharacter,
  makeEvent,
  makeMessage,
  makeSession,
  makeTurnMessage,
  makeWorld,
} from "../src/contract/test-fixtures.js";

describe("session checkpoint transfer", () => {
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
    await replaceSessionFromCheckpoint(target, checkpoint);

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
});
