type WorkspaceRunner = <T>(
  sessionId: string,
  actionId: string,
  mutate: () => Promise<T>,
) => Promise<T>;

let runner: WorkspaceRunner | null = null;

export function configureWorkspaceRunner(next: WorkspaceRunner): void {
  runner = next;
}

export function runWorkspaceMutation<T>(
  sessionId: string,
  actionId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  if (!runner) {
    throw new Error("Session workspace coordinator is not initialized");
  }
  return runner(sessionId, actionId, mutate);
}
