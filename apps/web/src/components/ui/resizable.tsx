import * as React from "react"
import { GripVertical, GripHorizontal } from "lucide-react"
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof PanelGroup>) => (
  <PanelGroup
    className={cn(
      "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
      className
    )}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof PanelResizeHandle> & {
  withHandle?: boolean
}) => (
  <PanelResizeHandle
    className={cn(
      "relative flex items-center justify-center bg-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
      "w-px data-[panel-group-direction=vertical]:w-full",
      "h-full data-[panel-group-direction=vertical]:h-px",
      "after:absolute after:inset-y-0 after:left-1/2 after:w-8 after:-translate-x-1/2",
      "data-[panel-group-direction=vertical]:after:left-0",
      "data-[panel-group-direction=vertical]:after:h-8",
      "data-[panel-group-direction=vertical]:after:w-full",
      "data-[panel-group-direction=vertical]:after:-translate-y-1/2",
      "data-[panel-group-direction=vertical]:after:translate-x-0",
      "hover:bg-primary/50 transition-colors cursor-col-resize data-[panel-group-direction=vertical]:cursor-row-resize z-[50]",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex items-center justify-center rounded-sm border bg-background shadow-sm h-5 w-4 data-[panel-group-direction=vertical]:h-4 data-[panel-group-direction=vertical]:w-5">
        <GripVertical className="h-3.5 w-3.5 data-[panel-group-direction=vertical]:hidden" />
        <GripHorizontal className="h-3.5 w-3.5 hidden data-[panel-group-direction=vertical]:block" />
      </div>
    )}
  </PanelResizeHandle>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
