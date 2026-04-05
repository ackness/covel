import * as React from "react"
import { GripVertical, GripHorizontal } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn("h-full w-full", className)}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  withHandle,
  className,
  orientation,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
  orientation?: "horizontal" | "vertical"
}) => {
  const isVertical = orientation === "vertical"

  return (
    <Separator
      className={cn(
        "relative flex items-center justify-center bg-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        isVertical ? "w-full h-2 cursor-row-resize" : "w-2 h-full cursor-col-resize",
        "hover:bg-primary/50 transition-colors z-[50]",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className={cn(
          "z-10 flex items-center justify-center rounded-sm border bg-background shadow-sm",
          isVertical ? "h-4 w-8" : "h-8 w-4"
        )}>
          {isVertical ? (
            <GripHorizontal className="h-3.5 w-3.5" />
          ) : (
            <GripVertical className="h-3.5 w-3.5" />
          )}
        </div>
      )}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
