import type { I18nText } from "@covel/shared";
import type {
  MessageRecord as StoreMessageRecord,
  SessionRecord as StoreSessionRecord,
  WorldRecord as StoreWorldRecord,
} from "@covel/store/browser-sync";
import type { MessageRecord, SessionRecord, WorldRecord } from "../api.js";

export function toFrontendWorld(w: StoreWorldRecord): WorldRecord {
  return {
    id: w.id,
    name: w.name as I18nText,
    description: w.description as I18nText,
    lore: w.lore as I18nText | undefined,
    locale: w.locale,
    tags: w.tags ? [...w.tags] : undefined,
    dimensions:
      w.dimensions ?? (w.metadata?.dimensions as WorldRecord["dimensions"]),
    metadata: w.metadata as WorldRecord["metadata"],
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function toFrontendSession(s: StoreSessionRecord): SessionRecord {
  return {
    id: s.id,
    worldId: s.worldId ?? "",
    status: s.status,
    locale: s.locale,
    phase: s.phase,
    completedPlayerTurns: s.completedPlayerTurns,
    setupRuntimes: { ...s.setupRuntimes },
    activePlugins: s.activePlugins,
    presetId: s.presetId,
    runtimeModelOverrides: s.runtimeModelOverrides
      ? { ...s.runtimeModelOverrides }
      : undefined,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toFrontendMessage(m: StoreMessageRecord): MessageRecord {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as MessageRecord["role"],
    content: m.content,
    ...(m.metadata as {
      turnId?: string;
      runtimeId?: string;
      kind?: string;
      block?: Record<string, unknown>;
    }),
    createdAt: m.createdAt,
  };
}
