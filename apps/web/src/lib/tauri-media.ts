// FIXME(audit-2026-04-26 P2): the current Tauri media bridge transports
// blob bytes as a JSON `number[]` over the IPC boundary. For media >1 MiB
// (notably video / generated images) this triggers a massive JSON encode
// in Rust + a second JS allocation when we feed the array into
// `new Uint8Array(...)`. The follow-up is to switch to a Tauri custom
// protocol (`tauri://media/<id>` served from Rust as raw bytes) or have
// the sidecar stream the blob over HTTP and let the webview decode it via
// `Response#blob()`. Until that lands, keep an eye on `native_media_read`
// /`native_media_write` for >5 MiB payloads — they are the single biggest
// IPC cost in Tauri builds today.
import type { MediaRef } from "@covel/shared";
import { getTauriCore } from "./desktop-bridge.js";

interface NativeMediaReadResponse {
  readonly id: string;
  readonly size: number;
  readonly bytes: readonly number[];
}

interface NativeMediaWriteResponse {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

interface NativeMediaExistsResponse {
  readonly exists: boolean;
}

export function hasNativeTauriMedia(): boolean {
  return getTauriCore() !== null;
}

interface NativeMediaReadAuth {
  /**
   * Marker proving the caller already passed the server-side media-token
   * authorization gate. This is a lightweight defense against accidental
   * direct use of the native fast path from future UI code; the authoritative
   * check remains `/api/sessions/:id/media-token` in `media-resolve.ts`.
   */
  readonly authorized: true;
}

export async function readNativeTauriMedia(
  ref: MediaRef,
  auth?: NativeMediaReadAuth,
): Promise<Blob | null> {
  if (!auth?.authorized) {
    console.warn(
      "[tauri-media] native media read requires prior media-token authorization",
    );
    return null;
  }
  const tauri = getTauriCore();
  if (!tauri) return null;
  try {
    const result = await tauri.invoke<NativeMediaReadResponse>(
      "native_media_read",
      { id: ref.id },
    );
    if (result.id !== ref.id || result.size !== ref.size) {
      console.warn("[tauri-media] native media read returned mismatched ref", {
        requested: ref,
        result,
      });
      return null;
    }
    return new Blob([new Uint8Array(result.bytes)], { type: ref.mime });
  } catch (err) {
    console.warn("[tauri-media] native media read failed", err);
    return null;
  }
}

export async function writeNativeTauriMedia(
  bytes: Uint8Array,
  mime: string,
  meta?: Readonly<Record<string, unknown>>,
): Promise<MediaRef | null> {
  const tauri = getTauriCore();
  if (!tauri) return null;
  try {
    const result = await tauri.invoke<NativeMediaWriteResponse>(
      "native_media_write",
      {
        req: {
          bytes: Array.from(bytes),
          mime,
          ...(meta === undefined ? {} : { meta }),
        },
      },
    );
    return {
      id: result.id,
      mime: result.mime,
      size: result.size,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    };
  } catch (err) {
    console.warn("[tauri-media] native media write failed", err);
    return null;
  }
}

export async function nativeTauriMediaExists(id: string): Promise<boolean> {
  const tauri = getTauriCore();
  if (!tauri) return false;
  try {
    const result = await tauri.invoke<NativeMediaExistsResponse>(
      "native_media_exists",
      { id },
    );
    return result.exists;
  } catch (err) {
    console.warn("[tauri-media] native media exists failed", err);
    return false;
  }
}
