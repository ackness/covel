import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestConfirm,
  subscribeConfirm,
  type PendingConfirm,
} from "../confirm-channel.js";

const REQUEST = {
  title: "Authorize plugin action",
  message: "Plugin foo requests permission to run bar.",
  confirmLabel: "Authorize",
  cancelLabel: "Deny",
};

describe("confirm-channel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to window.confirm when no host is mounted", async () => {
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);

    await expect(requestConfirm(REQUEST)).resolves.toBe(true);
    expect(native).toHaveBeenCalledWith(REQUEST.message);
  });

  it("resolves with the host's answer instead of the native dialog", async () => {
    const native = vi.spyOn(window, "confirm").mockReturnValue(true);
    const seen: PendingConfirm[] = [];
    const unsub = subscribeConfirm((pending) => seen.push(pending));

    const answer = requestConfirm(REQUEST);
    seen[0]!.resolve(false);

    await expect(answer).resolves.toBe(false);
    expect(native).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject(REQUEST);
    unsub();
  });

  it("delivers concurrent requests separately so neither is stranded", async () => {
    const seen: PendingConfirm[] = [];
    const unsub = subscribeConfirm((pending) => seen.push(pending));

    const first = requestConfirm(REQUEST);
    const second = requestConfirm({ ...REQUEST, message: "second" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.id).not.toBe(seen[1]!.id);

    seen[0]!.resolve(true);
    seen[1]!.resolve(false);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    unsub();
  });

  it("reverts to the native dialog once the host unsubscribes", async () => {
    const native = vi.spyOn(window, "confirm").mockReturnValue(false);
    const unsub = subscribeConfirm(() => {});
    unsub();

    await expect(requestConfirm(REQUEST)).resolves.toBe(false);
    expect(native).toHaveBeenCalledOnce();
  });
});
