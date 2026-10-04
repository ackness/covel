import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

/** A configuration file the server lets the app edit as text. */
export interface RawConfigFileInfo {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  /** What a saved file needs before it is in effect. */
  readonly applies: "reload" | "restart";
}

export interface RawConfigFile extends RawConfigFileInfo {
  /** The text of the file, or a starting text while it does not exist. */
  readonly content: string;
  /** Sent back with a save, so a file that changed on disk is not replaced. */
  readonly digest: string;
  /** Where the text before a save was kept. */
  readonly backup?: string;
  readonly reload?: { ok: boolean; slots: string[]; error?: string };
}

// The editor shows each failure beside the text, so none of these toasts.
const quiet = { operatorAuth: true, silentErrors: true } as const;

/** The editable files. A server that refuses the request offers none. */
export async function listRawConfigFiles(): Promise<RawConfigFileInfo[]> {
  try {
    const body = await request<{ items?: RawConfigFileInfo[] }>(
      "/api/config/raw",
      { ...quiet, headers: getDesktopRestAuthHeaders(), retry: false },
    );
    return Array.isArray(body.items) ? body.items : [];
  } catch {
    return [];
  }
}

export function readRawConfigFile(name: string): Promise<RawConfigFile> {
  return request<RawConfigFile>(`/api/config/raw/${encodeURIComponent(name)}`, {
    ...quiet,
    headers: getDesktopRestAuthHeaders(),
    retry: false,
  });
}

export function saveRawConfigFile(
  name: string,
  content: string,
  baseDigest: string,
): Promise<RawConfigFile> {
  return request<RawConfigFile>(`/api/config/raw/${encodeURIComponent(name)}`, {
    ...quiet,
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...getDesktopRestAuthHeaders(),
    },
    body: JSON.stringify({ content, baseDigest }),
  });
}
