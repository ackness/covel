import type { MessageRecord } from "../api.js";
import type { DataService, SessionWorkspaceOperations } from "./types.js";

interface WorkspaceRunOptions {
  readonly input?: MessageRecord;
  readonly isCurrent?: () => boolean;
}

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
    options?: WorkspaceRunOptions,
  ): Promise<T>;
  checkpoint(sessionId: string, actionId: string): Promise<void>;
}

export class SessionWorkspaceSyncError extends Error {
  constructor(
    readonly stage: "input" | "hydrate" | "checkpoint",
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
  constructor(private readonly dataService: DataService) {}

  private enqueue<T>(
    sessionId: string,
    operation: (workspace: SessionWorkspaceOperations) => Promise<T>,
  ): Promise<T> {
    if (!this.dataService.withSessionWorkspace) {
      return Promise.reject(
        new SessionWorkspaceSyncError(
          "hydrate",
          sessionId,
          undefined,
          new Error(
            "Local data service must provide exclusive workspace ownership",
          ),
        ),
      );
    }
    let admitted = false;
    return this.dataService
      .withSessionWorkspace(sessionId, (workspace) => {
        admitted = true;
        return operation(workspace);
      })
      .catch((error: unknown) => {
        if (admitted) throw error;
        throw new SessionWorkspaceSyncError(
          "hydrate",
          sessionId,
          undefined,
          error,
        );
      });
  }

  private async commit(
    sessionId: string,
    actionId: string,
    workspace: SessionWorkspaceOperations,
  ): Promise<void> {
    try {
      await workspace.commit(actionId);
    } catch (error) {
      throw new SessionWorkspaceSyncError(
        "checkpoint",
        sessionId,
        actionId,
        error,
      );
    }
  }

  private async stage(
    sessionId: string,
    actionId: string,
    workspace: SessionWorkspaceOperations,
  ): Promise<void> {
    try {
      await workspace.stage(actionId);
    } catch (error) {
      throw new SessionWorkspaceSyncError(
        "checkpoint",
        sessionId,
        actionId,
        error,
      );
    }
  }

  private async prepare(
    sessionId: string,
    workspace: SessionWorkspaceOperations,
  ): Promise<void> {
    try {
      await workspace.hydrate();
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
    return this.enqueue(sessionId, (workspace) =>
      this.prepare(sessionId, workspace),
    );
  }

  run<T>(
    sessionId: string,
    actionId: string,
    mutate: () => Promise<T>,
    options?: WorkspaceRunOptions,
  ): Promise<T> {
    return this.enqueue(sessionId, async (workspace) => {
      if (options?.isCurrent && !options.isCurrent())
        throw new Error("Action was superseded before execution");
      if (options?.input) {
        try {
          if (options.input.sessionId !== sessionId)
            throw new Error("Workspace input session mismatch");
          await workspace.persistInput(options.input);
        } catch (error) {
          throw new SessionWorkspaceSyncError(
            "input",
            sessionId,
            actionId,
            error,
          );
        }
      }
      await this.prepare(sessionId, workspace);
      await this.stage(sessionId, actionId, workspace);
      const result = await mutate();
      await this.commit(sessionId, actionId, workspace);
      return result;
    });
  }

  checkpoint(sessionId: string, actionId: string): Promise<void> {
    return this.enqueue(sessionId, async (workspace) => {
      await this.stage(sessionId, actionId, workspace);
      await this.commit(sessionId, actionId, workspace);
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
    options?: WorkspaceRunOptions,
  ): Promise<T> {
    if (options?.isCurrent && !options.isCurrent())
      return Promise.reject(
        new Error("Action was superseded before execution"),
      );
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
