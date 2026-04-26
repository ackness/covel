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

export async function readNativeTauriMedia(
  ref: MediaRef,
): Promise<Blob | null> {
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
