// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { subscribeToast, type ToastEvent } from "@/lib/toast-channel";
import { warnWhenCheckpointNearLimit } from "../sessions.js";

describe("checkpoint size warning", () => {
  const toasts: ToastEvent[] = [];
  const unsubscribe = subscribeToast((event) => toasts.push(event));
  afterEach(() => {
    toasts.length = 0;
  });

  it("tells the player once when a checkpoint reaches 80% of the upload limit", () => {
    warnWhenCheckpointNearLimit("small", "x".repeat(79), 100);
    expect(toasts).toEqual([]);

    warnWhenCheckpointNearLimit("near", "x".repeat(80), 100);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "info" });
    expect(toasts[0]!.message).toContain("80%");

    warnWhenCheckpointNearLimit("near", "x".repeat(95), 100);
    expect(toasts).toHaveLength(1);
    warnWhenCheckpointNearLimit("other", "x".repeat(95), 100);
    expect(toasts).toHaveLength(2);
  });

  it("measures bytes, not characters", () => {
    // 30 CJK characters are 90 bytes of UTF-8.
    warnWhenCheckpointNearLimit("cjk", "界".repeat(30), 100);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toContain("90%");
    unsubscribe();
  });
});
