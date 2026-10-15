import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { WorldRecord } from "@/services/api.js";

const api = vi.hoisted(() => ({ restoreWorldPackage: vi.fn() }));
vi.mock("@/services/api.js", () => api);
const confirm = vi.hoisted(() => ({ requestConfirm: vi.fn() }));
vi.mock("@/lib/confirm-channel.js", () => confirm);
const storage = vi.hoisted(() => ({ getStorageMode: vi.fn(() => "server") }));
vi.mock("@/services/data-service.js", () => storage);

const { WorldPackageRestore, canRestoreWorldPackage } =
  await import("../world-package-restore.js");

const world = {
  id: "mistport",
  name: "Mistport",
  description: "",
  locale: "en-US",
  metadata: { source: "file", packageModified: true },
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
} as WorldRecord;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorldPackageRestore", () => {
  it("offers the changed package even when the world has no app edits", () => {
    const updated = {
      ...world,
      metadata: { source: "file" },
      updateAvailable: true,
    };
    expect(canRestoreWorldPackage(updated)).toBe(true);
    storage.getStorageMode.mockReturnValueOnce("local");
    expect(canRestoreWorldPackage(updated)).toBe(false);
  });

  it("explains what an available update replaces and keeps before applying it", async () => {
    confirm.requestConfirm.mockResolvedValue(true);
    const restored = {
      ...world,
      updateAvailable: false,
      metadata: { source: "file" },
    };
    api.restoreWorldPackage.mockResolvedValue(restored);
    const onRestored = vi.fn();
    render(
      <WorldPackageRestore
        world={{ ...world, updateAvailable: true }}
        onRestored={onRestored}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain(
      "world data and settings are replaced",
    );
    // The panel sits on the details page; it does not send the player there.
    expect(screen.getByRole("note").textContent).not.toContain(
      "Open world details",
    );
    expect(screen.getByRole("note").textContent).toContain(
      "saved sessions are kept",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Restore the package version" }),
      );
    });
    expect(confirm.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("data and settings"),
        destructive: true,
      }),
    );
    expect(onRestored).toHaveBeenCalledWith(restored);
  });

  it("is shown for a package world edited on the server only", () => {
    expect(canRestoreWorldPackage(world)).toBe(true);
    expect(
      canRestoreWorldPackage({
        ...world,
        metadata: { source: "file" },
      } as WorldRecord),
    ).toBe(false);
    // A browser copy has no package on the server to go back to.
    storage.getStorageMode.mockReturnValueOnce("local");
    expect(canRestoreWorldPackage(world)).toBe(false);
  });

  it("asks first, then hands back the package version", async () => {
    const restored = { ...world, metadata: { source: "file" } };
    confirm.requestConfirm.mockResolvedValue(true);
    api.restoreWorldPackage.mockResolvedValue(restored);
    const onRestored = vi.fn();
    render(<WorldPackageRestore world={world} onRestored={onRestored} />);
    expect(screen.getByRole("note").textContent).toContain(
      "no longer replace it",
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Restore the package version" }),
      );
    });
    expect(confirm.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    );
    expect(api.restoreWorldPackage).toHaveBeenCalledWith("mistport");
    expect(onRestored).toHaveBeenCalledWith(restored);
  });

  it("changes nothing when the player cancels", async () => {
    confirm.requestConfirm.mockResolvedValue(false);
    const onRestored = vi.fn();
    render(<WorldPackageRestore world={world} onRestored={onRestored} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Restore the package version" }),
      );
    });
    expect(api.restoreWorldPackage).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
