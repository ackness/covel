import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { Shield, Sword, Lightbulb, Zap } from "lucide-react";
import type { BlockRendererProps } from "./block-renderer.js";

type SuggestionStyle = "safe" | "aggressive" | "creative" | "wild";

interface ActionCategory {
  style: SuggestionStyle;
  label: string;
  suggestions: string[];
}

const STYLE_CONFIG: Record<SuggestionStyle, {
  icon: typeof Shield;
  color: string;
  bg: string;
  border: string;
}> = {
  safe: {
    icon: Shield,
    color: "text-green-600 dark:text-green-400",
    bg: "bg-green-500/10 dark:bg-green-500/15",
    border: "border-green-500/30",
  },
  aggressive: {
    icon: Sword,
    color: "text-red-500 dark:text-red-400",
    bg: "bg-red-500/10 dark:bg-red-500/15",
    border: "border-red-500/30",
  },
  creative: {
    icon: Lightbulb,
    color: "text-amber-500 dark:text-amber-400",
    bg: "bg-amber-500/10 dark:bg-amber-500/15",
    border: "border-amber-500/30",
  },
  wild: {
    icon: Zap,
    color: "text-purple-500 dark:text-purple-400",
    bg: "bg-purple-500/10 dark:bg-purple-500/15",
    border: "border-purple-500/30",
  },
};

export function ActionGuideBlock({ data, onSubmit, onSelect, selectedValue, disabled }: BlockRendererProps) {
  const [customInput, setCustomInput] = useState("");
  const topic = data.topic as string | undefined;
  const categories = (data.categories as ActionCategory[]) ?? [];
  const handleClick = onSelect ?? onSubmit;

  const handleSuggestionClick = (suggestion: string) => {
    if (!disabled) handleClick(suggestion);
  };

  const handleCustomSubmit = () => {
    const val = customInput.trim();
    if (val && !disabled) {
      if (onSelect) {
        onSelect(val);
      } else {
        onSubmit(val);
      }
      setCustomInput("");
    }
  };

  return (
    <Card className="max-w-lg">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
          {topic ?? "Actions"}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 space-y-2">
        {categories.map((cat) => {
          const config = STYLE_CONFIG[cat.style] ?? STYLE_CONFIG.safe;
          const Icon = config.icon;

          return (
            <div key={cat.style} className={`border ${config.border} ${config.bg} p-2`}>
              <div className={`flex items-center gap-1.5 mb-1.5 ${config.color}`}>
                <Icon className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-wider">
                  {cat.label}
                </span>
              </div>
              <div className="space-y-1">
                {cat.suggestions.map((suggestion, i) => (
                  <Button
                    key={i}
                    variant={selectedValue === suggestion ? "default" : "ghost"}
                    className="w-full justify-start text-left text-xs h-auto py-2 px-3 rounded-none hover:bg-background/50"
                    disabled={disabled}
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Custom input */}
        <div className="flex gap-2 pt-1 border-t border-border">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCustomSubmit();
              }
            }}
            placeholder="Or type your own action..."
            disabled={disabled}
            className="flex-1 min-w-0 bg-background border border-border px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <Button
            size="sm"
            variant="outline"
            className="rounded-none text-xs shrink-0"
            disabled={disabled || !customInput.trim()}
            onClick={handleCustomSubmit}
          >
            Go
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
