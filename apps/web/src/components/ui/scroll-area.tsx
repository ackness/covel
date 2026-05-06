import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
	<ScrollAreaPrimitive.Root
		ref={ref}
		className={cn("relative overflow-hidden", className)}
		{...props}
	>
		{/*
      Radix wraps its viewport children in `<div style="display:table; min-width:100%">`,
      which lets inner content set its own width and breaks `truncate` / `min-w-0`
      patterns inside the panel. Force the wrapper to `block` so flex children
      respect the viewport width and truncate correctly.
    */}
		<ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit] [&>div]:!block">
			{children}
		</ScrollAreaPrimitive.Viewport>
		<ScrollBar />
		<ScrollAreaPrimitive.Corner />
	</ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
	<ScrollAreaPrimitive.ScrollAreaScrollbar
		ref={ref}
		orientation={orientation}
		className={cn(
			"flex touch-none select-none transition-opacity",
			orientation === "vertical" && "h-full w-2 p-[2px]",
			orientation === "horizontal" && "h-2 flex-col p-[2px]",
			className,
		)}
		{...props}
	>
		<ScrollAreaPrimitive.ScrollAreaThumb
			className="relative flex-1 rounded-full transition-colors"
			style={{
				background:
					"color-mix(in oklab, var(--color-foreground) 18%, transparent)",
			}}
		/>
	</ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
