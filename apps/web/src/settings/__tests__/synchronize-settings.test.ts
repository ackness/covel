import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import { synchronizeSettings } from "../synchronize-settings.js";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("settings browser synchronization", () => {
  it("refreshes keys independently on storage and refreshes both channels on focus", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const refreshSecrets = vi.fn().mockResolvedValue(undefined);
    stop = synchronizeSettings({
      isHydrated: () => true,
      refresh,
      refreshSecrets,
    } as unknown as SettingsStoreApi);
    window.dispatchEvent(new StorageEvent("storage", { key: "covel:keys" }));
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshSecrets).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "covel:settings" }),
    );
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refreshSecrets).toHaveBeenCalledTimes(2);
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
      refreshSecrets: vi.fn().mockResolvedValue(undefined),
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
