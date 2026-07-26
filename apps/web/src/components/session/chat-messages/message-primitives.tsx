import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Settings2,
} from "lucide-react";
import { Markdown } from "@/components/ui/markdown.js";
import type { StreamMessage } from "@/stores/session-store.js";

interface NarrativeMessageBodyProps {
  isUser: boolean;
  isHiddenAssistantKind: boolean;
  content: string;
}

/**
 * Memoised message-body renderer. Splitting this out gives each message row a
 * stable memo boundary so high-frequency state changes elsewhere in the chat
 * (e.g. a streaming delta on the latest turn, or a per-message image-gen
 * toggle) do not force every already-rendered narrative body — including the
 * expensive markdown parse — to re-render. Re-renders only when this row's own
 * content or display mode changes.
 */
/**
 * Markdown collapses a lone newline into a space, but a player who pressed
 * Enter — or a choice label carrying its own line structure — meant a break.
 * Promote single newlines to markdown hard breaks (two trailing spaces) and
 * leave blank-line paragraph breaks untouched.
 *
 * ponytail: a string rewrite rather than the `remark-breaks` plugin — one
 * regex against a dependency, for the same result everywhere but fenced code.
 */
export function preserveSoftBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

function NonMemoNarrativeMessageBody({
  isUser,
  isHiddenAssistantKind,
  content,
}: NarrativeMessageBodyProps) {
  return (
    <div
      className={`text-sm wrap-break-words w-full ${
        isUser
          ? "ui-message-player prose prose-sm max-w-[90%] md:max-w-[85%] border border-border p-4 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          : isHiddenAssistantKind
            ? "ui-message-assistant max-w-none border-l-2 border-border/40 pl-3 py-1 font-mono text-[12px] text-muted-foreground/80 whitespace-pre-wrap"
            : "ui-message-assistant ui-narrative prose prose-sm max-w-none border-0 p-0"
      }`}
    >
      {isUser ? (
        // Players paste choice text and type markdown; render it the same way
        // the narrative is rendered instead of as one flat line.
        <Markdown>{preserveSoftBreaks(content)}</Markdown>
      ) : isHiddenAssistantKind ? (
        // Plugin/debug kinds in detailed view — preserve the raw text so the
        // structure of what the runtime emitted is visible, but skip the
        // narrative-prose styling to signal "this is not story".
        content
      ) : (
        <Markdown>{content}</Markdown>
      )}
    </div>
  );
}

export const NarrativeMessageBody = memo(NonMemoNarrativeMessageBody);

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
