import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRef, MediaStore } from "@covel/shared";
import {
  __resetBrowserMediaStoreForTests,
  deleteBrowserMedia,
  getBrowserMedia,
  getBrowserMediaStore,
  putBrowserMedia,
  resolveBrowserMediaUrl,
} from "../browser-media-adapter.js";

const put = vi.fn<MediaStore["put"]>();
const get = vi.fn<MediaStore["get"]>();
const resolveUrl = vi.fn<MediaStore["resolveUrl"]>();
const deleteById = vi.fn<MediaStore["delete"]>();
const mocks = vi.hoisted(() => ({
  createBrowserMediaStore: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  BROWSER_MEDIA_STORE_DB_NAME: "covel-browser",
  createBrowserMediaStore: mocks.createBrowserMediaStore,
}));

const ref: MediaRef = {
  id: "sha256-abc",
  mime: "image/png",
  size: 3,
};

function makeStore(): MediaStore {
  return {
    put,
    get,
    exists: vi.fn(),
    resolveUrl,
    delete: deleteById,
    lookup: vi.fn(),
    recordOwnership: vi.fn(),
    addRef: vi.fn(),
    removeRef: vi.fn(),
    isReferencedBy: vi.fn(),
    listAssets: vi.fn().mockResolvedValue([]),
    listRefs: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue({
      scanned: 0,
      protected: 0,
      retained: 0,
      deleted: 0,
      totalBytes: 0,
      bytesDeleted: 0,
      bytesRetained: 0,
      protectedIds: [],
      deletedIds: [],
    }),
  };
}

describe("browser-media-adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBrowserMediaStoreForTests();
    mocks.createBrowserMediaStore.mockResolvedValue(makeStore());
    put.mockResolvedValue(ref);
    get.mockResolvedValue(new Blob(["abc"], { type: "image/png" }));
    resolveUrl.mockResolvedValue("blob:https://app.example/1");
    deleteById.mockResolvedValue(undefined);
  });

  it("opens the shared browser media database once", async () => {
    const first = await getBrowserMediaStore();
    const second = await getBrowserMediaStore();

    expect(first).toBe(second);
    expect(mocks.createBrowserMediaStore).toHaveBeenCalledTimes(1);
    expect(mocks.createBrowserMediaStore).toHaveBeenCalledWith("covel-browser");
  });

  it("forwards media operations to the IndexedDB media store", async () => {
    const blob = new Blob(["abc"], { type: "image/png" });

    await expect(
      putBrowserMedia(blob, "image/png", { width: 1 }),
    ).resolves.toEqual(ref);
    await expect(getBrowserMedia(ref)).resolves.toBeInstanceOf(Blob);
    await expect(resolveBrowserMediaUrl(ref)).resolves.toBe(
      "blob:https://app.example/1",
    );
    await expect(deleteBrowserMedia(ref.id)).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledWith(blob, "image/png", { width: 1 });
    expect(get).toHaveBeenCalledWith(ref);
    expect(resolveUrl).toHaveBeenCalledWith(ref);
    expect(deleteById).toHaveBeenCalledWith(ref.id);
  });
});
