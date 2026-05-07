import * as React from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group className={cn("h-full w-full", className)} {...props} />
);

const ResizablePanel = Panel;

/**
 * ResizableHandle — quiet hairline handle.
 *
 * Default: a 1px hairline using --rule-color. The grip becomes visible only
 * on hover, expanding to a 4px stripe of --accent-primary so the user can
 * still find it. No floating "card-with-grip-button" decoration anymore —
 * that read as junk on the editorial canvas.
 */
const ResizableHandle = ({
  className,
  orientation,
  ...props
}: React.ComponentProps<typeof Separator> & {
  /** kept for API compat; no longer renders a grip badge */
  withHandle?: boolean;
  orientation?: "horizontal" | "vertical";
}) => {
  const isVertical = orientation === "vertical";

  // Strip out the legacy `withHandle` prop so it doesn't reach the DOM.
  // (We accept it for API compatibility but ignore it.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { withHandle: _withHandle, ...rest } = props as {
    withHandle?: boolean;
  };

  return (
    <Separator
      className={cn(
        "ui-resize-handle relative shrink-0 transition-colors focus-visible:outline-none focus-visible:bg-[var(--accent-primary)]",
        isVertical
          ? "w-full h-px cursor-row-resize"
          : "h-full w-px cursor-col-resize",
        className,
      )}
      style={{
        background: "var(--rule-color)",
      }}
      {...rest}
    />
  );
};

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
