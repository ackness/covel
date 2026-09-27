import type { LorebookOwner } from "@covel/shared";
import { lorebookOwnerKey } from "./lorebook-owner.js";

export function stateEntryKey(
  sessionId: string,
  tableName: string,
  fieldName: string,
): string {
  return JSON.stringify([sessionId, tableName, fieldName]);
}

export function pluginDataKey(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return JSON.stringify([sessionId, pluginId, namespace, key]);
}

export function lorebookEntryKey(
  sessionId: string,
  owner: LorebookOwner,
  id: string,
): string {
  return JSON.stringify([sessionId, lorebookOwnerKey(owner), id]);
}

export function characterKey(sessionId: string, id: string): string {
  return JSON.stringify([sessionId, id]);
}

export function vectorRowKey(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): string {
  return JSON.stringify([sessionId, pluginId, namespace, key]);
}
