import { useCallback, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";

export interface PanelCollapseControls {
  /** Ref to attach to the left ResizablePanel. */
  leftPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Ref to attach to the right ResizablePanel. */
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Live collapsed state of the left panel. */
  isLeftCollapsed: boolean;
  /** Live collapsed state of the right panel. */
  isRightCollapsed: boolean;
  /** Sync handler for the left panel's `onResize`. */
  handleLeftResize: (size: PanelSize) => void;
  /** Sync handler for the right panel's `onResize`. */
  handleRightResize: (size: PanelSize) => void;
  /** Toggle the left panel between collapsed and expanded. */
  toggleLeftPanel: () => void;
  /** Toggle the right panel between collapsed and expanded. */
  toggleRightPanel: () => void;
}

/**
 * Owns the collapse state of the left/right resizable panels.
 *
 * Resize callbacks own observed state. Breakpoint changes must never call
 * imperative methods while the panel registry is adding or removing rails.
 */
export function usePanelCollapse(): PanelCollapseControls {
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  // Mirrors the left panel's `defaultSize="0%"` in GameView — the handle and
  // the header toggle read this before the first `onResize` fires.
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(true);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  const handleLeftResize = useCallback((size: PanelSize) => {
    setIsLeftCollapsed(size.asPercentage === 0);
  }, []);
  const handleRightResize = useCallback((size: PanelSize) => {
    setIsRightCollapsed(size.asPercentage === 0);
  }, []);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (isLeftCollapsed) panel.expand();
      else panel.collapse();
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) panel.expand();
      else panel.collapse();
    }
  };

  return {
    leftPanelRef,
    rightPanelRef,
    isLeftCollapsed,
    isRightCollapsed,
    handleLeftResize,
    handleRightResize,
    toggleLeftPanel,
    toggleRightPanel,
  };
}
