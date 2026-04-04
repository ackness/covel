import { useState, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";

export function RawJsonBlock({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group border border-border bg-muted/10">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 border border-border bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Copy"
      >
        {copied ? (
          <Check className="w-3 h-3 text-green-500" />
        ) : (
          <Copy className="w-3 h-3 text-muted-foreground" />
        )}
      </button>
      <pre className="p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
        {content}
      </pre>
    </div>
  );
}
