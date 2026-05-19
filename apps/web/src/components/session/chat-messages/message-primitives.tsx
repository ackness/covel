import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Settings2,
} from "lucide-react";
import type { StreamMessage } from "@/stores/session-store.js";

export function SubmittedSelectionFooter({
  values,
}: {
  values?: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const label = values?._label;
  if (typeof label !== "string" || !label.trim()) return null;
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground italic pl-0.5">
      <span className="font-semibold not-italic">
        {t("interaction.playerSelected")}
      </span>
      <span className="whitespace-pre-wrap break-words">{label}</span>
    </div>
  );
}

export function SystemMessageLine({ msg }: { msg: StreamMessage }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const content = msg.content ?? "";
  // First non-empty line is the best proxy for a headline.
  const summary =
    content
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const hasMore = content.trim().length > summary.length;

  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-foreground/90 font-mono">
      <button
        type="button"
        onClick={() => hasMore && setExpanded((v) => !v)}
        disabled={!hasMore}
        className="flex items-start gap-1.5 text-left hover:text-foreground transition-colors disabled:cursor-default disabled:hover:text-muted-foreground/90"
      >
        {hasMore ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 mt-[3px] shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="w-3 h-3 mt-[3px] shrink-0 opacity-70" />
          )
        ) : (
          <Settings2 className="w-3 h-3 mt-[3px] shrink-0 opacity-60" />
        )}
        <span className="truncate">
          {msg.runtimeId && (
            <span className="opacity-60 mr-1.5">[{msg.runtimeId}]</span>
          )}
          {summary || (
            <span className="italic opacity-60">
              {t("session.system", "system")}
            </span>
          )}
        </span>
      </button>
      {expanded && hasMore && (
        <pre className="ml-4 pl-2 border-l border-border/60 text-[11px] whitespace-pre-wrap break-words text-muted-foreground/80">
          {content}
        </pre>
      )}
    </div>
  );
}

export function RawJsonBlock({ content }: { content: string }) {
  const { t } = useTranslation();
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
        title={t("common.copy", "Copy")}
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
