import type { PlannedWrite } from "./types.js";

export function pluginWriteIdentity(write: PlannedWrite): string | null {
  if (write.kind === "plugin-data" || write.kind === "media-index") {
    return `plugin:${write.pluginId}/${write.namespace}:${write.key}`;
  }
  if (write.kind === "lorebook") return `lorebook:${write.id}`;
  if (write.kind === "character") return `characters:${write.key}`;
  return null;
}

export function sameSourceDuplicateIdentity(
  write: PlannedWrite,
): string | null {
  const identity = pluginWriteIdentity(write);
  return identity ? `${write.source.id}:${identity}` : null;
}

export function writeKey(write: PlannedWrite): string {
  if (write.kind === "plugin-data" || write.kind === "media-index") {
    return `${write.target}:${write.pluginId}:${write.namespace}:${write.key}`;
  }
  if (write.kind === "lorebook") {
    return `${write.target}:::${write.id}`;
  }
  return `${write.target}:::${write.key}`;
}
