import type { DataStore } from "@covel/store";

/**
 * Point an existing session at a world. `updateSession` cannot change the
 * world, so the record is replaced; its metadata and other fields are kept.
 */
export async function setSessionWorld(
  store: DataStore,
  sessionId: string,
  worldId: string,
): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  await store.deleteSession(sessionId);
  await store.createSession({ ...session, worldId });
}
