import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../resizable.js";
import { RawJsonBlock } from "@/components/session/chat-messages/message-primitives.js";
import { RuntimeChip } from "@/components/session/execution-runtime-status.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("allows the separator focus color to override its idle color", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <ResizablePanelGroup>
      <ResizablePanel id="left">Left</ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="right">Right</ResizablePanel>
    </ResizablePanelGroup>,
  );
  const separator = screen.getByRole("separator");
  expect(separator.style.background).toBe("");
  expect(separator.className).toContain("focus-visible:bg-(--accent-primary)");
});

it("names copy and retry controls and reveals them for keyboard and touch users", () => {
  const retry = vi.fn();
  render(
    <>
      <RawJsonBlock content="{}" />
      <RuntimeChip
        rt={{
          runtimeId: "task",
          pluginId: "plugin",
          label: "Task",
          status: "failed",
        }}
        canRetry
        onRetry={retry}
        retryFromLabel="Retry task"
      />
    </>,
  );
  const copy = screen.getByRole("button", { name: "复制" });
  const retryButton = screen.getByRole("button", { name: "Retry task" });
  for (const button of [copy, retryButton]) {
    expect(button.getAttribute("aria-label")).toBeTruthy();
    expect(button.className).toContain("focus-visible:opacity-100");
    expect(button.className).toContain("[@media(hover:none)]:opacity-100");
  }
  fireEvent.click(retryButton);
  expect(retry).toHaveBeenCalledWith("task");
});
