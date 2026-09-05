import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import { synchronizeSettings } from "../synchronize-settings.js";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("settings browser synchronization", () => {
  it("refreshes preferences on storage and focus without observing keys", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    stop = synchronizeSettings({
      isHydrated: () => true,
      refresh,
    } as unknown as SettingsStoreApi);
    window.dispatchEvent(new StorageEvent("storage", { key: "covel:keys" }));
    expect(refresh).not.toHaveBeenCalled();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "covel:settings" }),
    );
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces events during a read and retries once after it finishes", async () => {
    let release!: () => void;
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    stop = synchronizeSettings({
      isHydrated: () => true,
      refresh,
    } as unknown as SettingsStoreApi);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
