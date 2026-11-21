import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspace,
  SessionWorkspaceSyncError,
} from "../workspace.js";
import type { DataService, SessionWorkspaceOperations } from "../types.js";
import type { MessageRecord } from "../../api.js";

const input: MessageRecord = {
  id: "input",
  sessionId: "sess-1",
  role: "user",
  content: "Continue",
  createdAt: "2026-01-01T00:00:00Z",
};

function makeWorkspace(order: string[], mode: "local" | "remote" = "local") {
  const scope = crypto.randomUUID();
  const operations = {
    persistInput: vi.fn<SessionWorkspaceOperations["persistInput"]>(
      async () => {
        order.push("input");
      },
    ),
    hydrate: vi.fn(async () => {
      order.push("hydrate");
    }),
    stage: vi.fn(async (actionId: string) => {
      order.push(`stage:${actionId}`);
    }),
    commit: vi.fn(async (actionId: string) => {
      order.push(`checkpoint:${actionId}`);
    }),
  } satisfies SessionWorkspaceOperations;
  const service = {
    withSessionWorkspace<T>(
      sessionId: string,
      operation: (workspace: SessionWorkspaceOperations) => Promise<T>,
    ) {
      return navigator.locks.request(`${scope}:${sessionId}`, () =>
        operation(operations),
      );
    },
  } as unknown as DataService;
  return { workspace: createSessionWorkspace(service, mode), operations };
}

describe("SessionWorkspace", () => {
  it("persists input inside ownership before uploading or executing", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order);
    await workspace.run(
      "sess-1",
      "action",
      async () => {
        order.push("mutate");
      },
      { input },
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
    const { workspace, operations } = makeWorkspace(order);
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
        input,
      },
    );
    const rejected = expect(queued).rejects.toThrow("superseded");
    current = false;
    release();
    await first;
    await rejected;
    expect(operations.persistInput).not.toHaveBeenCalled();
    expect(order).toEqual([
      "hydrate",
      "stage:first-action",
      "checkpoint:first-action",
    ]);
  });

  it("skips a mirror recovery superseded while waiting for workspace ownership", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order);
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = workspace.run("session", "active", async () => {
      start();
      await hold;
    });
    await started;
    let current = true;
    const queued = workspace.hydrate("session", { isCurrent: () => current });
    current = false;
    release();
    await Promise.all([first, queued]);
    expect(order).toEqual(["hydrate", "stage:active", "checkpoint:active"]);
  });

  it("does not dispatch an action when input persistence fails", async () => {
    const order: string[] = [];
    const { workspace, operations } = makeWorkspace(order);
    const cause = new Error("storage unavailable");
    operations.persistInput.mockRejectedValueOnce(cause);
    await expect(
      workspace.run(
        "sess-1",
        "action",
        async () => {
          order.push("mutate");
        },
        { input },
      ),
    ).rejects.toMatchObject({ stage: "input", cause });
    expect(order).toEqual([]);
  });

  it("does not checkpoint a failed mutation", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order);
    const cause = new Error("transport failed");

    await expect(
      workspace.run("sess-1", "action-1", async () => {
        order.push("mutate");
        throw cause;
      }),
    ).rejects.toBe(cause);

    expect(order).toEqual(["hydrate", "stage:action-1", "mutate"]);
  });

  it("preserves the checkpoint error and releases ownership for the next mutation", async () => {
    const order: string[] = [];
    const { workspace, operations } = makeWorkspace(order);
    const cause = new Error("download failed");
    operations.commit.mockRejectedValueOnce(cause);

    await expect(
      workspace.run("sess-1", "action-1", async () => {
        order.push("mutate:1");
      }),
    ).rejects.toMatchObject({
      name: SessionWorkspaceSyncError.name,
      stage: "checkpoint",
      sessionId: "sess-1",
      actionId: "action-1",
      cause: expect.toSatisfy((value: unknown) => value === cause),
    });

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
    expect(operations.commit).toHaveBeenNthCalledWith(2, "action-2");
  });

  it("serializes a terminal background checkpoint after an in-flight mutation", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order);
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
    const { workspace } = makeWorkspace(order);
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
    const { workspace } = makeWorkspace(order, "remote");

    await expect(
      workspace.run(
        "sess-1",
        "action-1",
        async () => {
          order.push("mutate");
          return "done";
        },
        { input },
      ),
    ).resolves.toBe("done");
    await workspace.hydrate("sess-1");
    await workspace.checkpoint("sess-1", "background:event-1");

    expect(order).toEqual(["mutate"]);
  });

  it("does not retain a rejected remote run or break subsequent settle calls", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order, "remote");

    await expect(
      workspace.run("sess-1", "failed-action", async () => {
        throw new Error("aborted turn");
      }),
    ).rejects.toThrow("aborted turn");

    await expect(workspace.settle?.("sess-1")).resolves.toBeUndefined();

    await expect(
      workspace.run("sess-1", "next-action", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("awaits all overlapping in-flight remote runs in settle even when a newer run finishes first", async () => {
    const order: string[] = [];
    const { workspace } = makeWorkspace(order, "remote");
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    const first = workspace.run("sess-1", "first", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = workspace.run("sess-1", "second", async () => {
      order.push("second:start");
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      order.push("second:end");
    });

    releaseSecond();
    await second;

    let settled = false;
    const settling = workspace.settle!("sess-1").then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst();
    await Promise.all([first, settling]);
    expect(settled).toBe(true);
    expect(order).toEqual([
      "first:start",
      "second:start",
      "second:end",
      "first:end",
    ]);
  });

  it("retains local mode rejection semantics in settle to guard stale checkpoints", async () => {
    const order: string[] = [];
    const { workspace, operations } = makeWorkspace(order, "local");
    const cause = new Error("checkpoint failed");
    operations.commit.mockRejectedValueOnce(cause);

    await expect(
      workspace.run("sess-1", "action-1", async () => {}),
    ).rejects.toMatchObject({ stage: "checkpoint" });

    await expect(workspace.settle?.("sess-1")).rejects.toMatchObject({
      stage: "checkpoint",
    });
  });
});
