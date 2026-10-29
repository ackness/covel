// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearStreamingTextForTest,
  appendStreamingText,
  clearStreamingText,
  resetStreamingText,
  subscribeToStreamingChanges,
  getStreamingText,
  subscribeToStreamingText,
} from "../streaming-text-store.js";

describe("streaming-text-store", () => {
  beforeEach(() => __clearStreamingTextForTest());

  it("notifies only listeners for the changed message", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeToStreamingText("stream-t1-a", first);
    const offSecond = subscribeToStreamingText("stream-t1-b", second);

    expect(appendStreamingText("stream-t1-a", "hel")).toBe(true);
    expect(appendStreamingText("stream-t1-a", "lo")).toBe(false);

    expect(getStreamingText("stream-t1-a")).toBe("hello");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    offFirst();
    offSecond();
  });

  it("distinguishes discarded drafts from completion and starts a fresh text generation", () => {
    const listener = vi.fn();
    const off = subscribeToStreamingChanges(listener);
    appendStreamingText("stream-t1-a", "Discarded");
    resetStreamingText("stream-t1-a");
    expect(getStreamingText("stream-t1-a")).toBe("");
    expect(listener.mock.lastCall).toEqual([
      { messageId: "stream-t1-a", type: "reset" },
    ]);
    expect(appendStreamingText("stream-t1-a", "Replacement")).toBe(true);
    expect(getStreamingText("stream-t1-a")).toBe("Replacement");
    clearStreamingText("stream-t1-a");
    expect(listener.mock.lastCall).toEqual([
      { messageId: "stream-t1-a", type: "complete" },
    ]);
    off();
  });

  it("clears a completed stream and notifies its row", () => {
    const listener = vi.fn();
    subscribeToStreamingText("stream-t1-a", listener);
    appendStreamingText("stream-t1-a", "partial");

    clearStreamingText("stream-t1-a");

    expect(getStreamingText("stream-t1-a")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
