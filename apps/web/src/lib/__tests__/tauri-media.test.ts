import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRef } from "@covel/shared";
import {
  hasNativeTauriMedia,
  nativeTauriMediaExists,
  readNativeTauriMedia,
  writeNativeTauriMedia,
} from "../tauri-media.js";

const originalTauri = window.__TAURI__;
type TauriInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

afterEach(() => {
  if (originalTauri === undefined) {
    delete window.__TAURI__;
  } else {
    window.__TAURI__ = originalTauri;
  }
});

describe("tauri media adapter", () => {
  const ref: MediaRef = {
    id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    mime: "image/png",
    size: 3,
  };

  it("reports native media availability from the Tauri global", () => {
    delete window.__TAURI__;
    expect(hasNativeTauriMedia()).toBe(false);
    window.__TAURI__ = { core: { invoke: vi.fn() as unknown as TauriInvoke } };
    expect(hasNativeTauriMedia()).toBe(true);
  });

  it("refuses native reads without an authorization marker", async () => {
    const invoke = vi.fn(async () => ({
      id: ref.id,
      size: ref.size,
      bytes: [1, 2, 3],
    }));
    window.__TAURI__ = { core: { invoke: invoke as unknown as TauriInvoke } };

    await expect(readNativeTauriMedia(ref)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads native media into a typed Blob after authorization", async () => {
    const invoke = vi.fn(async () => ({
      id: ref.id,
      size: ref.size,
      bytes: [1, 2, 3],
    }));
    window.__TAURI__ = { core: { invoke: invoke as unknown as TauriInvoke } };

    const blob = await readNativeTauriMedia(ref, { authorized: true });

    expect(invoke).toHaveBeenCalledWith("native_media_read", { id: ref.id });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
    expect(blob?.size).toBe(3);
  });

  it("ignores mismatched native read responses", async () => {
    window.__TAURI__ = {
      core: {
        invoke: vi.fn(async () => ({
          id: ref.id,
          size: 4,
          bytes: [1, 2, 3, 4],
        })) as unknown as TauriInvoke,
      },
    };

    await expect(
      readNativeTauriMedia(ref, { authorized: true }),
    ).resolves.toBeNull();
  });

  it("writes bytes through the native command and returns a MediaRef", async () => {
    const invoke = vi.fn(async () => ({
      id: ref.id,
      mime: ref.mime,
      size: ref.size,
      meta: { prompt: "avatar" },
    }));
    window.__TAURI__ = { core: { invoke: invoke as unknown as TauriInvoke } };

    const out = await writeNativeTauriMedia(
      new Uint8Array([1, 2, 3]),
      "image/png",
      { prompt: "avatar" },
    );

    expect(invoke).toHaveBeenCalledWith("native_media_write", {
      req: {
        bytes: [1, 2, 3],
        mime: "image/png",
        meta: { prompt: "avatar" },
      },
    });
    expect(out).toEqual({ ...ref, meta: { prompt: "avatar" } });
  });

  it("checks native existence", async () => {
    const invoke = vi.fn(async () => ({ exists: true }));
    window.__TAURI__ = { core: { invoke: invoke as unknown as TauriInvoke } };

    await expect(nativeTauriMediaExists(ref.id)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("native_media_exists", { id: ref.id });
  });
});
