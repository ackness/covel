import type { TFunction } from "i18next";
import { getDataService } from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";

export interface ChatExportMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
}

/** Merge persisted history with uncommitted in-memory rows by authoritative id. */
export function mergeChatExportMessages(
  persisted: readonly ChatExportMessage[],
  inMemory: readonly ChatExportMessage[],
): readonly ChatExportMessage[] {
  const persistedIds = new Set(persisted.map((message) => message.id));
  return [
    ...persisted,
    ...inMemory.filter((message) => !persistedIds.has(message.id)),
  ];
}

/**
 * Download the session's chat as a text file. History comes from storage (the
 * chat window holds only the latest messages), merged with messages that are
 * still being written; a failed fetch falls back to what is on screen.
 */
export async function exportChat(
  t: TFunction,
  sessionId: string | undefined,
  inMemory: ReadonlyArray<{ id: string; role: string; content: string }>,
): Promise<void> {
  let msgs = inMemory;
  if (sessionId) {
    try {
      const full = await getDataService().listMessages(sessionId);
      if (full.length > 0) msgs = mergeChatExportMessages(full, inMemory);
    } catch {
      // Fall back to the messages already loaded.
    }
  }
  if (msgs.length === 0) {
    emitToast("info", t("session.exportEmpty", "No messages to export yet"));
    return;
  }
  try {
    const text = msgs.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "covel-chat.txt";
    a.click();
    URL.revokeObjectURL(url);
    emitToast("success", t("session.exportSuccess", "Chat exported"));
  } catch (err) {
    emitToast(
      "error",
      t("session.exportFailed", "Failed to export chat"),
      err instanceof Error ? err.message : String(err),
    );
  }
}
