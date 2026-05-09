import type * as api from "@/services/api.js";

export function activeSessionRecords(
  sessions: readonly api.SessionRecord[],
): api.SessionRecord[] {
  return sessions.filter((session) => session.status !== "ended");
}

export function removeSessionById(
  sessions: readonly api.SessionRecord[],
  sessionId: string,
): api.SessionRecord[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function startPluginsPayload(
  pluginIds: readonly string[],
): string[] | undefined {
  return pluginIds.length > 0 ? [...pluginIds] : undefined;
}
