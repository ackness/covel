import { useCallback, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";

export interface PanelCollapseControls {
  /** Ref to attach to the right ResizablePanel. */
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Live collapsed state of the right panel. */
  isRightCollapsed: boolean;
  /** Sync handler for the right panel's `onResize`. */
  handleRightResize: (size: PanelSize) => void;
  /** Toggle the right panel between collapsed and expanded. */
  toggleRightPanel: () => void;
}

/**
 * Owns the collapse state of the right resizable panel.
 *
 * Resize callbacks own observed state. Breakpoint changes must never call
 * imperative methods while the panel registry is adding or removing the rail.
 */
export function usePanelCollapse(): PanelCollapseControls {
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  const handleRightResize = useCallback((size: PanelSize) => {
    setIsRightCollapsed(size.asPercentage === 0);
  }, []);

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) panel.expand();
      else panel.collapse();
    }
  };

  return {
    rightPanelRef,
    isRightCollapsed,
    handleRightResize,
    toggleRightPanel,
  };
}
