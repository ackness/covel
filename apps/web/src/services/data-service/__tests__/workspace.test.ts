import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspace,
  SessionWorkspaceSyncError,
} from "../workspace.js";
import type { DataService } from "../types.js";

function makeService(order: string[]): DataService {
  return {
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
}

describe("SessionWorkspace", () => {
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

  it("recovers a failed checkpoint before uploading an older browser revision", async () => {
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
      "checkpoint:action-1",
      "hydrate",
      "stage:action-2",
      "mutate:2",
      "checkpoint:action-2",
    ]);
    expect(service.commitFromServer).toHaveBeenNthCalledWith(
      2,
      "sess-1",
      "action-1",
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
