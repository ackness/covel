import { afterEach, describe, expect, it } from "vitest";

import { createMessage, createSession, createWorld } from "../../../modules/domain/src/index.js";

import {
  createDatabaseEnvironment,
  clearProviderEnvironment,
  importRuntimeComposition,
  importRuntimeCompositionWithStorageSpies,
  resetRuntimeCompositionModules
} from "./helpers/runtime-composition-storage.js";

describe("createRuntimeComposition PostgreSQL persistence selection", () => {
  afterEach(() => {
    resetRuntimeCompositionModules();
  });

  it("does not choose the in-memory storage path when DATABASE_URL is configured", async () => {
    const {
      createRuntimeComposition,
      createPostgresStoragePort,
      inMemoryFactory
    } = await importRuntimeCompositionWithStorageSpies();

    await createRuntimeComposition({
      env: createDatabaseEnvironment()
    });

    expect(createPostgresStoragePort).toHaveBeenCalledTimes(1);
    expect(inMemoryFactory).not.toHaveBeenCalled();
  });

  it("keeps world, session, and message records readable after recreating the composition with the same DATABASE_URL", async () => {
    const { createRuntimeComposition } = await importRuntimeComposition();
    const env = createDatabaseEnvironment();

    const firstComposition = await createRuntimeComposition({ env });
    const world = createWorld({
      id: "world_pg_01",
      name: "Northreach",
      description: "Frozen frontier",
      createdAt: new Date("2026-03-25T00:00:00.000Z")
    });
    const session = createSession({
      id: "session_pg_01",
      worldId: world.id,
      status: "active",
      createdAt: new Date("2026-03-25T00:00:01.000Z")
    });
    const message = createMessage({
      id: "message_pg_01",
      sessionId: session.id,
      role: "user",
      content: "Remember this across composition restarts.",
      createdAt: new Date("2026-03-25T00:00:02.000Z")
    });

    await firstComposition.repositories.worlds.save(world);
    await firstComposition.repositories.sessions.save(session);
    await firstComposition.repositories.messages.save(message);

    const secondComposition = await createRuntimeComposition({ env });

    await expect(secondComposition.repositories.worlds.getById(world.id)).resolves.toEqual(world);
    await expect(secondComposition.repositories.sessions.getById(session.id)).resolves.toEqual(session);
    await expect(secondComposition.repositories.messages.listBySessionId(session.id)).resolves.toEqual([message]);
  });

  it("falls back to the in-memory storage path when DATABASE_URL is missing", async () => {
    const {
      createRuntimeComposition,
      createPostgresStoragePort,
      inMemoryFactory
    } = await importRuntimeCompositionWithStorageSpies();

    await createRuntimeComposition({
      env: clearProviderEnvironment()
    });

    expect(inMemoryFactory).toHaveBeenCalledTimes(1);
    expect(createPostgresStoragePort).not.toHaveBeenCalled();
  });
});
