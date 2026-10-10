import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { emitNavEvent } from "@/lib/nav-events.js";
import { usePanelCollapse } from "../game-view/use-panel-collapse.js";
import { useNavTabActivation } from "../game-view/use-nav-tab-activation.js";

afterEach(cleanup);

describe("responsive panel lifecycle", () => {
  it("handles resize without querying a panel that is between registrations", () => {
    const { result } = renderHook(() => usePanelCollapse());
    const isCollapsed = vi.fn(() => {
      throw new Error("Panel constraints not found");
    });
    result.current.rightPanelRef.current = {
      isCollapsed,
    } as unknown as PanelImperativeHandle;
    act(() =>
      result.current.handleRightResize({ asPercentage: 0, inPixels: 0 }),
    );
    expect(result.current.isRightCollapsed).toBe(true);
    act(() =>
      result.current.handleRightResize({ asPercentage: 26, inPixels: 390 }),
    );
    expect(result.current.isRightCollapsed).toBe(false);
    expect(isCollapsed).not.toHaveBeenCalled();
  });

  it("does not call a stale rail ref when collapse state changes or the hook unmounts", () => {
    const { result, rerender, unmount } = renderHook(() => usePanelCollapse());
    const stale = {
      collapse: vi.fn(() => {
        throw new Error("Panel unmounted");
      }),
      expand: vi.fn(() => {
        throw new Error("Panel unmounted");
      }),
      isCollapsed: vi.fn(() => {
        throw new Error("Panel unmounted");
      }),
    };
    result.current.rightPanelRef.current =
      stale as unknown as PanelImperativeHandle;
    act(() =>
      result.current.handleRightResize({ asPercentage: 0, inPixels: 0 }),
    );
    rerender();
    act(() =>
      result.current.handleRightResize({ asPercentage: 26, inPixels: 390 }),
    );
    rerender();
    unmount();
    expect(stale.collapse).not.toHaveBeenCalled();
    expect(stale.expand).not.toHaveBeenCalled();
    expect(stale.isCollapsed).not.toHaveBeenCalled();
  });

  it("uses the current navigation target after both breakpoint transitions", () => {
    const expand = vi.fn();
    const onOpenContext = vi.fn();
    const rightPanelRef = {
      current: {
        isCollapsed: () => true,
        expand,
      } as unknown as PanelImperativeHandle,
    };
    const onOpenPlugins = vi.fn();
    const { rerender } = renderHook(
      ({ mobile }) =>
        useNavTabActivation({
          rightPanelRef,
          onOpenPlugins,
          onOpenContext: mobile ? onOpenContext : undefined,
        }),
      { initialProps: { mobile: false } },
    );
    act(() => emitNavEvent("open-database"));
    expect(expand).toHaveBeenCalledTimes(1);
    rerender({ mobile: true });
    act(() => emitNavEvent("open-database"));
    expect(onOpenContext).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(1);
    rerender({ mobile: false });
    act(() => emitNavEvent("open-database"));
    expect(expand).toHaveBeenCalledTimes(2);
  });
  it("retains navigation while a mobile drawer has not mounted yet", () => {
    const onOpenContext = vi.fn();
    const onPanelHandled = vi.fn();
    const { result } = renderHook(() =>
      useNavTabActivation({
        rightPanelRef: { current: null },
        onOpenPlugins: vi.fn(),
        onOpenContext,
        requestedPanel: "images",
        onPanelHandled,
      }),
    );
    expect(onOpenContext).toHaveBeenCalledOnce();
    expect(onPanelHandled).toHaveBeenCalledOnce();
    expect(result.current?.event).toBe("open-images");
    act(() =>
      emitNavEvent({
        type: "open-plugin-panel",
        pluginId: "custom",
        panelId: "tools",
      }),
    );
    expect(result.current?.event).toEqual({
      type: "open-plugin-panel",
      pluginId: "custom",
      panelId: "tools",
    });
  });
});
