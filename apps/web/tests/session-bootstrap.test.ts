import { describe, expect, it, vi } from "vitest";

import {
  createSessionFixture
} from "./helpers/fixtures.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface SessionBootstrapModule {
  bootstrapSessionForWorld(input: {
    worldId: string;
    listSessionsByWorldId(worldId: string): Promise<Array<Record<string, unknown>>>;
    createSession(input: { worldId: string }): Promise<Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
}

describe("apps/web session bootstrap", () => {
  it("reuses the latest active session for a world before creating a new one", async () => {
    const { bootstrapSessionForWorld } = await loadWebModule<SessionBootstrapModule>(
      "session/bootstrap.ts"
    );
    const listSessionsByWorldId = vi.fn(async () => [
      createSessionFixture({
        id: "ses_archived",
        status: "archived",
        createdAt: "2026-03-24T10:00:00.000Z"
      }),
      createSessionFixture({
        id: "ses_02",
        status: "active",
        createdAt: "2026-03-24T12:30:00.000Z"
      })
    ]);
    const createSession = vi.fn(async ({ worldId }: { worldId: string }) =>
      createSessionFixture({
        id: "ses_new",
        worldId
      })
    );

    const session = await bootstrapSessionForWorld({
      worldId: "world_01",
      listSessionsByWorldId,
      createSession
    });

    expect(listSessionsByWorldId).toHaveBeenCalledWith("world_01");
    expect(createSession).not.toHaveBeenCalled();
    expect(session).toEqual(
      expect.objectContaining({
        id: "ses_02",
        status: "active"
      })
    );
  });

  it("creates a session when the selected world has no reusable active session", async () => {
    const { bootstrapSessionForWorld } = await loadWebModule<SessionBootstrapModule>(
      "session/bootstrap.ts"
    );
    const listSessionsByWorldId = vi.fn(async () => []);
    const createSession = vi.fn(async ({ worldId }: { worldId: string }) =>
      createSessionFixture({
        id: "ses_created",
        worldId
      })
    );

    const session = await bootstrapSessionForWorld({
      worldId: "world_new",
      listSessionsByWorldId,
      createSession
    });

    expect(createSession).toHaveBeenCalledWith({
      worldId: "world_new"
    });
    expect(session).toEqual(
      expect.objectContaining({
        id: "ses_created",
        worldId: "world_new"
      })
    );
  });
});
