import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearStreamingTextForTest,
  appendStreamingText,
  clearStreamingText,
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

  it("clears a completed stream and notifies its row", () => {
    const listener = vi.fn();
    subscribeToStreamingText("stream-t1-a", listener);
    appendStreamingText("stream-t1-a", "partial");

    clearStreamingText("stream-t1-a");

    expect(getStreamingText("stream-t1-a")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
