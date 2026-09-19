import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspace,
  SessionWorkspaceSyncError,
} from "../workspace.js";
import type { DataService, SessionWorkspaceOperations } from "../types.js";

function makeService(order: string[]): DataService {
  const scope = crypto.randomUUID();
  const service = {
    withSessionWorkspace<T>(
      sessionId: string,
      operation: (workspace: SessionWorkspaceOperations) => Promise<T>,
    ) {
      return navigator.locks.request(`${scope}:${sessionId}`, () =>
        operation({
          persistInput: (message) => service.addMessage(message),
          hydrate: () => service.syncToServer(sessionId),
          stage: (actionId) => service.stageServerCommit(sessionId, actionId),
          commit: (actionId) => service.commitFromServer(sessionId, actionId),
        }),
      );
    },
    syncToServer: vi.fn(async () => {
      order.push("hydrate");
    }),
    stageServerCommit: vi.fn(async (_sessionId, actionId) => {
      order.push(`stage:${actionId}`);
    }),
    commitFromServer: vi.fn(async (_sessionId, actionId) => {
      order.push(`checkpoint:${actionId}`);
    }),
  } as unknown as DataService;
  return service;
}

describe("SessionWorkspace", () => {
  it("persists input inside ownership before uploading or executing", async () => {
    const order: string[] = [];
    const service = makeService(order);
    service.addMessage = vi.fn(async () => {
      order.push("input");
    });
    const workspace = createSessionWorkspace(service, "local");
    await workspace.run(
      "sess-1",
      "action",
      async () => {
        order.push("mutate");
      },
      {
        input: {
          id: "input",
          sessionId: "sess-1",
          role: "user",
          content: "Continue",
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    expect(order).toEqual([
      "input",
      "hydrate",
      "stage:action",
      "mutate",
      "checkpoint:action",
    ]);
  });

  it("does not persist input or execute a superseded queued action", async () => {
    const order: string[] = [];
    const service = makeService(order);
    service.addMessage = vi.fn();
    const workspace = createSessionWorkspace(service, "local");
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = workspace.run("sess-1", "first-action", async () => {
      start();
      await hold;
    });
    await started;
    let current = true;
    const queued = workspace.run(
      "sess-1",
      "action",
      async () => {
        order.push("mutate");
      },
      {
        isCurrent: () => current,
        input: {
          id: "input",
          sessionId: "sess-1",
          role: "user",
          content: "Continue",
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
    );
    const rejected = expect(queued).rejects.toThrow("superseded");
    current = false;
    release();
    await first;
    await rejected;
    expect(service.addMessage).not.toHaveBeenCalled();
    expect(order).toEqual([
      "hydrate",
      "stage:first-action",
      "checkpoint:first-action",
    ]);
  });

  it("does not dispatch an action when input persistence fails", async () => {
    const order: string[] = [];
    const service = makeService(order);
    service.addMessage = vi
      .fn()
      .mockRejectedValue(new Error("storage unavailable"));
    const workspace = createSessionWorkspace(service, "local");
    await expect(
      workspace.run(
        "sess-1",
        "action",
        async () => {
          order.push("mutate");
        },
        {
          input: {
            id: "input",
            sessionId: "sess-1",
            role: "user",
            content: "Continue",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      ),
    ).rejects.toMatchObject({ stage: "input" });
    expect(order).toEqual([]);
  });
  it("keeps local hydrate, stage, mutation, and commit in one FIFO job", async () => {
    const order: string[] = [];
    const workspace = createSessionWorkspace(makeService(order), "local");

    await workspace.run("sess-1", "action-1", async () => {
      order.push("mutate");
      return "done";
    });

    expect(order).toEqual([
      "hydrate",
      "stage:action-1",
      "mutate",
      "checkpoint:action-1",
    ]);
  });

  it("does not checkpoint a failed mutation", async () => {
    const order: string[] = [];
    const workspace = createSessionWorkspace(makeService(order), "local");

    await expect(
      workspace.run("sess-1", "action-1", async () => {
        order.push("mutate");
        throw new Error("transport failed");
      }),
    ).rejects.toThrow("transport failed");

    expect(order).toEqual(["hydrate", "stage:action-1", "mutate"]);
  });

  it("delegates failed checkpoint recovery to the next data-service hydration", async () => {
    const order: string[] = [];
    const service = makeService(order);
    vi.mocked(service.commitFromServer)
      .mockRejectedValueOnce(new Error("download failed"))
      .mockImplementation(async (_sessionId, actionId) => {
        order.push(`checkpoint:${actionId}`);
      });
    const workspace = createSessionWorkspace(service, "local");

    await expect(
      workspace.run("sess-1", "action-1", async () => {
        order.push("mutate:1");
      }),
    ).rejects.toBeInstanceOf(SessionWorkspaceSyncError);

    await workspace.run("sess-1", "action-2", async () => {
      order.push("mutate:2");
    });

    expect(order).toEqual([
      "hydrate",
      "stage:action-1",
      "mutate:1",
      "hydrate",
      "stage:action-2",
      "mutate:2",
      "checkpoint:action-2",
    ]);
    expect(service.commitFromServer).toHaveBeenNthCalledWith(
      2,
      "sess-1",
      "action-2",
    );
  });

  it("serializes a terminal background checkpoint after an in-flight mutation", async () => {
    const order: string[] = [];
    const workspace = createSessionWorkspace(makeService(order), "local");
    let releaseMutation!: () => void;
    const mutation = workspace.run("sess-1", "turn-1", async () => {
      order.push("mutate:start");
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      order.push("mutate:end");
    });
    const background = workspace.checkpoint("sess-1", "background:event-1");

    await vi.waitFor(() =>
      expect(order).toEqual(["hydrate", "stage:turn-1", "mutate:start"]),
    );
    releaseMutation();
    await Promise.all([mutation, background]);

    expect(order).toEqual([
      "hydrate",
      "stage:turn-1",
      "mutate:start",
      "mutate:end",
      "checkpoint:turn-1",
      "stage:background:event-1",
      "checkpoint:background:event-1",
    ]);
  });

  it("serializes per session without blocking an independent session", async () => {
    const order: string[] = [];
    const workspace = createSessionWorkspace(makeService(order), "local");
    let releaseFirst!: () => void;
    const first = workspace.run("sess-1", "action-1", async () => {
      order.push("mutate:1:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("mutate:1:end");
    });

    await vi.waitFor(() =>
      expect(order).toEqual(["hydrate", "stage:action-1", "mutate:1:start"]),
    );

    const second = workspace.run("sess-2", "action-2", async () => {
      order.push("mutate:2");
    });
    let beforeRelease: string[] = [];
    try {
      await vi.waitFor(() => expect(order).toContain("checkpoint:action-2"));
      beforeRelease = [...order];
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }

    expect(beforeRelease).toEqual([
      "hydrate",
      "stage:action-1",
      "mutate:1:start",
      "hydrate",
      "stage:action-2",
      "mutate:2",
      "checkpoint:action-2",
    ]);
    expect(order.slice(-2)).toEqual(["mutate:1:end", "checkpoint:action-1"]);
  });

  it("runs remote mutations directly without mirror calls", async () => {
    const order: string[] = [];
    const workspace = createSessionWorkspace(makeService(order), "remote");

    await workspace.run("sess-1", "action-1", async () => {
      order.push("mutate");
    });
    await workspace.hydrate("sess-1");
    await workspace.checkpoint("sess-1", "background:event-1");

    expect(order).toEqual(["mutate"]);
  });
});
