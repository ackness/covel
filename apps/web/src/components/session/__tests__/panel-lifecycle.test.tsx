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

  it("does not call a stale rail ref when mobile unmounts the panels", () => {
    const { result, rerender } = renderHook(() => usePanelCollapse(), {
      initialProps: { mobile: false },
    });
    const collapse = vi.fn(() => {
      throw new Error("Panel unmounted");
    });
    result.current.rightPanelRef.current = {
      collapse,
    } as unknown as PanelImperativeHandle;
    rerender({ mobile: true });
    expect(collapse).not.toHaveBeenCalled();
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
});
