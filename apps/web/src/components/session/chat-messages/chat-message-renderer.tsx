import type { TFunction } from "i18next";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { useStreamingText } from "@/stores/streaming-text-store.js";
import {
  NarrativeMessageBody,
  SystemMessageLine,
} from "./message-primitives.js";

export interface ChatMessageRendererProps {
  readonly msg: StreamMessage;
  readonly viewMode: "parsed" | "detailed" | "raw";
  readonly isImageGenActive: boolean;
  readonly sessionId: string | undefined;
  readonly executing: boolean;
  readonly generatingImage: boolean;
  readonly onGenerateImage: () => void;
  readonly t: TFunction;
}

/**
 * Renders a single non-block message.
 *
 * Visibility rules per view mode:
 *   parsed   — user/narrative/plugin-inline only. System + debug kinds hidden.
 *   detailed — everything parsed shows, PLUS system messages as compact
 *              one-liners. Raw JSON / internal LLM trace stays hidden.
 *   raw      — show every message as JSON for inspection.
 */
export function ChatMessageRenderer({
  msg: rawMessage,
  viewMode,
  isImageGenActive,
  sessionId,
  executing,
  generatingImage,
  onGenerateImage,
  t,
}: ChatMessageRendererProps) {
  const liveText = useStreamingText(rawMessage.id);
  const msg =
    liveText === undefined || liveText === rawMessage.content
      ? rawMessage
      : { ...rawMessage, content: liveText };
  // Raw mode: show everything as JSON, no filtering
  if (viewMode === "raw") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {msg.role}
          {msg.kind && (
            <span className="ml-1.5 text-[10px] font-mono opacity-60">
              [{msg.kind}]
            </span>
          )}
          {msg.runtimeId && (
            <span className="ml-1.5 text-[10px] font-mono opacity-60">
              {msg.runtimeId}
            </span>
          )}
          {msg.turnId && (
            <span className="ml-2 font-mono text-[10px]">{msg.turnId}</span>
          )}
        </span>
        <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-w-[90%] md:max-w-[85%]">
          {JSON.stringify(
            {
              role: msg.role,
              kind: msg.kind,
              runtimeId: msg.runtimeId,
              content: msg.content,
              turnId: msg.turnId,
            },
            null,
            2,
          )}
        </div>
      </div>
    );
  }

  // System messages — hidden in parsed mode; compact line in detailed mode.
  if (msg.role === "system") {
    if (viewMode !== "detailed") return null;
    return <SystemMessageLine msg={msg} />;
  }
  // Non-story assistant kinds (plugin debug traces, intermediate runtime
  // chatter) stay hidden in parsed mode — the player only wants narrative.
  // Detailed mode surfaces them with a runtime badge so the author can see
  // which runtime emitted what without leaving the chat surface.
  const isAssistant = msg.role === "assistant";
  const isHiddenAssistantKind =
    isAssistant &&
    msg.kind &&
    msg.kind !== "story" &&
    msg.kind !== "plugin-message";
  if (isHiddenAssistantKind && viewMode !== "detailed") return null;

  const isUser = msg.role === "user";
  const showImageButton =
    !isUser &&
    isImageGenActive &&
    msg.kind === "story" &&
    msg.content &&
    sessionId;
  // Detailed view affordance: show the runtime/plugin source above each
  // assistant message so the author knows which runtime produced it. Hidden
  // in parsed mode to keep the narrative immersive.
  const showSourceBadge =
    viewMode === "detailed" && isAssistant && (msg.runtimeId || msg.kind);

  return (
    <div
      className={`ui-message-row flex flex-col gap-1.5 w-full ${isUser ? "items-end" : "items-start"}`}
    >
      {showSourceBadge && (
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          {msg.runtimeId ?? t("session.assistant", "assistant")}
          {msg.kind && msg.kind !== "story" && (
            <span className="ml-1.5 opacity-60">· {msg.kind}</span>
          )}
        </span>
      )}
      <span
        className={`ui-eyebrow text-xs ${isUser ? "text-primary" : "text-muted-foreground"}`}
      >
        {isUser
          ? t("session.player", "Player")
          : t("session.assistant", "Assistant")}
        {msg.turnId && (
          <span className="ml-2 font-mono text-[10px]">
            {isUser ? `· ${msg.turnId}` : msg.turnId}
          </span>
        )}
      </span>

      <NarrativeMessageBody
        isUser={isUser}
        isHiddenAssistantKind={Boolean(isHiddenAssistantKind)}
        content={msg.content}
      />

      {showImageButton && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1 ui-eyebrow"
            disabled={executing || generatingImage}
            onClick={onGenerateImage}
            title={t("coreImage.generateButton")}
          >
            <ImageIcon
              className={`h-3 w-3 ${generatingImage ? "animate-pulse" : ""}`}
            />
            {generatingImage
              ? t("session.stateStreaming")
              : t("coreImage.generateButton")}
          </Button>
        </div>
      )}
    </div>
  );
}
