import type { DataService } from "./types.js";

/**
 * Coordinates the browser-private server mirror around session mutations.
 *
 * A browser checkpoint is the durable authority in local mode. Keep its
 * upload, the server mutation, and the downloaded commit in one per-session
 * FIFO job so two operations never export from the same revision.
 */
export interface SessionWorkspace {
  hydrate(sessionId: string): Promise<void>;
  run<T>(
    sessionId: string,
    actionId: string,
    mutate: () => Promise<T>,
  ): Promise<T>;
  checkpoint(sessionId: string, actionId: string): Promise<void>;
}

export class SessionWorkspaceSyncError extends Error {
  constructor(
    readonly stage: "hydrate" | "checkpoint",
    readonly sessionId: string,
    readonly actionId: string | undefined,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Session workspace ${stage} failed: ${detail}`);
    this.name = "SessionWorkspaceSyncError";
  }
}

class LocalSessionWorkspace implements SessionWorkspace {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingCommits = new Map<string, string>();

  constructor(private readonly dataService: DataService) {}

  private enqueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const tail = this.tails.get(sessionId) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    this.tails.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async commit(sessionId: string, actionId: string): Promise<void> {
    try {
      await this.dataService.commitFromServer(sessionId, actionId);
      if (this.pendingCommits.get(sessionId) === actionId) {
        this.pendingCommits.delete(sessionId);
      }
    } catch (error) {
      this.pendingCommits.set(sessionId, actionId);
      throw new SessionWorkspaceSyncError(
        "checkpoint",
        sessionId,
        actionId,
        error,
      );
    }
  }

  private async stage(sessionId: string, actionId: string): Promise<void> {
    try {
      await this.dataService.stageServerCommit(sessionId, actionId);
    } catch (error) {
      throw new SessionWorkspaceSyncError(
        "checkpoint",
        sessionId,
        actionId,
        error,
      );
    }
  }

  private async prepare(sessionId: string): Promise<void> {
    const pendingActionId = this.pendingCommits.get(sessionId);
    if (pendingActionId) {
      await this.commit(sessionId, pendingActionId);
    }
    try {
      await this.dataService.syncToServer(sessionId);
    } catch (error) {
      throw new SessionWorkspaceSyncError(
        "hydrate",
        sessionId,
        undefined,
        error,
      );
    }
  }

  hydrate(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, () => this.prepare(sessionId));
  }

  run<T>(
    sessionId: string,
    actionId: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(sessionId, async () => {
      await this.prepare(sessionId);
      await this.stage(sessionId, actionId);
      const result = await mutate();
      this.pendingCommits.set(sessionId, actionId);
      await this.commit(sessionId, actionId);
      return result;
    });
  }

  checkpoint(sessionId: string, actionId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const pendingActionId = this.pendingCommits.get(sessionId);
      if (pendingActionId && pendingActionId !== actionId) {
        await this.commit(sessionId, pendingActionId);
      }
      await this.stage(sessionId, actionId);
      this.pendingCommits.set(sessionId, actionId);
      await this.commit(sessionId, actionId);
    });
  }
}

class RemoteSessionWorkspace implements SessionWorkspace {
  hydrate(): Promise<void> {
    return Promise.resolve();
  }

  run<T>(
    _sessionId: string,
    _actionId: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    return mutate();
  }

  checkpoint(): Promise<void> {
    return Promise.resolve();
  }
}

export function createSessionWorkspace(
  dataService: DataService,
  mode: "local" | "remote",
): SessionWorkspace {
  return mode === "local"
    ? new LocalSessionWorkspace(dataService)
    : new RemoteSessionWorkspace();
}
