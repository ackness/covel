import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

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
  handleLeftResize: () => void;
  /** Sync handler for the right panel's `onResize`. */
  handleRightResize: () => void;
  /** Toggle the left panel between collapsed and expanded. */
  toggleLeftPanel: () => void;
  /** Toggle the right panel between collapsed and expanded. */
  toggleRightPanel: () => void;
}

/**
 * Owns the collapse state of the left/right resizable panels.
 *
 * Keeps imperative panel refs in sync with React state, auto-collapses both
 * rails on small viewports, and exposes toggles. Behaviour is identical to the
 * inline logic previously embedded in GameView.
 */
export function usePanelCollapse(
  isMobile: boolean,
  isTablet: boolean,
): PanelCollapseControls {
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);

  const isLeftCollapsedRef = useRef(isLeftCollapsed);
  const isRightCollapsedRef = useRef(isRightCollapsed);
  isLeftCollapsedRef.current = isLeftCollapsed;
  isRightCollapsedRef.current = isRightCollapsed;

  useEffect(() => {
    if (isMobile || isTablet) {
      if (leftPanelRef.current && !isLeftCollapsedRef.current)
        leftPanelRef.current.collapse();
      if (rightPanelRef.current && !isRightCollapsedRef.current)
        rightPanelRef.current.collapse();
    }
  }, [isMobile, isTablet]);

  const handleLeftResize = () =>
    setIsLeftCollapsed(leftPanelRef.current?.isCollapsed() ?? false);
  const handleRightResize = () =>
    setIsRightCollapsed(rightPanelRef.current?.isCollapsed() ?? false);

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
