export async function bootstrapSessionForWorld(input: {
  worldId: string;
  listSessionsByWorldId(worldId: string): Promise<Array<Record<string, unknown>>>;
  createSession(input: { worldId: string }): Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const sessions = await input.listSessionsByWorldId(input.worldId);
  const activeSessions = sessions
    .filter((session) => session.status === "active")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
    );

  if (activeSessions.length > 0) {
    return activeSessions[0]!;
  }

  return input.createSession({
    worldId: input.worldId
  });
}
