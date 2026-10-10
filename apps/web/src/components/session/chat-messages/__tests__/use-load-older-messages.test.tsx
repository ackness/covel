import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useLoadOlderMessages } from "../use-load-older-messages.js";

it("reports a failed page load and loads again on retry", async () => {
  const viewportEl = document.createElement("div");
  const onLoadOlder = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined);
  const { result } = renderHook(() =>
    useLoadOlderMessages({
      viewportEl,
      hasOlder: true,
      firstMessageId: "m1",
      onLoadOlder,
    }),
  );
  await act(async () => result.current.retry());
  expect(result.current.loadFailed).toBe(true);
  await act(async () => result.current.retry());
  expect(onLoadOlder).toHaveBeenCalledTimes(2);
  expect(result.current.loadFailed).toBe(false);
});
