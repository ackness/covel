import { request } from "./request.js";

// -- Lorebook (framework-owned) -------------------------------

export interface LorebookEntry {
  id: string;
  sessionId?: string;
  content: string;
  keys: string[];
  enabled: boolean;
  strategy: string;
  insertionOrder: number;
  pluginId: string;
  position: string;
  extra?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface LorebookEntryInput {
  id: string;
  pluginId?: string;
  content: string;
  keys?: string[];
  strategy?: "constant" | "selective";
  position?: string;
  insertionOrder?: number;
  enabled?: boolean;
  extra?: unknown;
}

export async function fetchLorebookEntries(
  sessionId: string,
): Promise<LorebookEntry[]> {
  const res = await request<{ entries: LorebookEntry[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook`,
  );
  return res.entries;
}

export async function createLorebookEntry(
  sessionId: string,
  entry: LorebookEntryInput,
): Promise<LorebookEntry> {
  const res = await request<{ entry: LorebookEntry }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook`,
    { method: "POST", body: JSON.stringify(entry) },
  );
  return res.entry;
}

export async function updateLorebookEntry(
  sessionId: string,
  entryId: string,
  entry: Omit<LorebookEntryInput, "id">,
): Promise<LorebookEntry> {
  const res = await request<{ entry: LorebookEntry }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "PUT", body: JSON.stringify(entry) },
  );
  return res.entry;
}

export async function updateLorebookEntryEnabled(
  sessionId: string,
  entryId: string,
  enabled: boolean,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
  );
}

export async function deleteLorebookEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "DELETE" },
  );
}
