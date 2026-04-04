import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Image, Loader2, AlertCircle, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

export function StoryImageBlock({ data }: BlockRendererProps) {
  const [showDetails, setShowDetails] = useState(false);

  const status = (data.status as "generating" | "ready" | "error") ?? "generating";
  const imageUrl = data.imageUrl as string | undefined;
  const originalPrompt = data.originalPrompt as string | undefined;
  const enhancedPrompt = data.enhancedPrompt as string | undefined;
  const isMultiScene = data.isMultiScene as boolean | undefined;
  const stylePreset = data.stylePreset as string | undefined;
  const error = data.error as string | undefined;

  const hasEnhancement = Boolean(enhancedPrompt);

  if (status === "generating") {
    return (
      <Card className="max-w-md">
        <CardContent className="p-6 flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            Generating illustration...
          </p>
          {hasEnhancement && (
            <Badge variant="outline" className="rounded-none text-[9px]">
              <Sparkles className="h-3 w-3 mr-1" /> LLM Enhanced
            </Badge>
          )}
        </CardContent>
      </Card>
    );
  }

  if (status === "error") {
    return (
      <div className="inline-flex items-center gap-3 border border-destructive/50 bg-destructive/5 px-4 py-3 max-w-md">
        <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-destructive">Image generation failed</span>
          {error && <span className="text-xs text-muted-foreground">{error}</span>}
        </div>
      </div>
    );
  }

  // status === "ready"
  return (
    <Card className="max-w-lg overflow-hidden">
      {imageUrl && (
        <div className="w-full bg-muted">
          <img
            src={imageUrl}
            alt="Story illustration"
            className="w-full h-auto object-contain"
            loading="lazy"
          />
        </div>
      )}
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Image className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Story Illustration
          </span>
          {stylePreset && (
            <Badge variant="outline" className="rounded-none text-[9px] py-0">
              {stylePreset}
            </Badge>
          )}
          {hasEnhancement && (
            <Badge variant="outline" className="rounded-none text-[9px] py-0 text-amber-600 dark:text-amber-400 border-amber-500/30">
              <Sparkles className="h-2.5 w-2.5 mr-0.5" /> Enhanced
            </Badge>
          )}
          {isMultiScene && (
            <Badge variant="outline" className="rounded-none text-[9px] py-0">
              Multi-panel
            </Badge>
          )}
        </div>

        {/* Details toggle */}
        {(originalPrompt || enhancedPrompt) && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground"
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
              Prompt details
            </Button>

            {showDetails && (
              <div className="mt-1 space-y-2 border-t border-border pt-2">
                {originalPrompt && (
                  <div>
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      Original
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">{originalPrompt}</p>
                  </div>
                )}
                {enhancedPrompt && (
                  <div>
                    <span className="text-[10px] uppercase tracking-widest text-amber-600 dark:text-amber-400">
                      Enhanced
                    </span>
                    <p className="text-xs text-foreground mt-0.5">{enhancedPrompt}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
