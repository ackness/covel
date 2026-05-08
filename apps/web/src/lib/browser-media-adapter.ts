import type { MediaRef, MediaStore } from "@covel/shared";
import {
  BROWSER_MEDIA_STORE_DB_NAME,
  createBrowserMediaStore,
} from "@/services/storage";

let browserMediaStorePromise: Promise<MediaStore> | null = null;

export function getBrowserMediaStore(): Promise<MediaStore> {
  if (!browserMediaStorePromise) {
    browserMediaStorePromise = createBrowserMediaStore(
      BROWSER_MEDIA_STORE_DB_NAME,
    );
  }
  return browserMediaStorePromise;
}

export function __resetBrowserMediaStoreForTests(): void {
  browserMediaStorePromise = null;
}

export async function putBrowserMedia(
  blob: Uint8Array | Blob,
  mime: string,
  meta?: object,
): Promise<MediaRef> {
  const store = await getBrowserMediaStore();
  return store.put(blob, mime, meta);
}

export async function getBrowserMedia(
  ref: MediaRef,
): Promise<Uint8Array | Blob> {
  const store = await getBrowserMediaStore();
  return store.get(ref);
}

export async function resolveBrowserMediaUrl(ref: MediaRef): Promise<string> {
  const store = await getBrowserMediaStore();
  return store.resolveUrl(ref);
}

export async function deleteBrowserMedia(id: string): Promise<void> {
  const store = await getBrowserMediaStore();
  await store.delete(id);
}
