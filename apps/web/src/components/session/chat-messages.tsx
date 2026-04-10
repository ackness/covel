import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Copy,
  Check,
  Flame,
  ImageIcon,
  MessageSquare,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Button } from "@/components/ui/button.js";
import { Markdown } from "@/components/ui/markdown.js";
import { getBlockRenderer } from "@/components/blocks/block-renderer.js";
import { resolveBlockSubmission } from "@/lib/block-submission-utils.js";
import { ExecutionTimeline } from "./execution-timeline.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type {
  WorldRecord,
  PackageSummary,
  SessionPluginInfo,
} from "@/services/api.js";

// ── Types ────────────────────────────────────────────────────────

export interface ChatMessagesProps {
  messages: StreamMessage[];
  executionSteps: ExecutionStep[];
  executionError: string | null;
  executing: boolean;
  phase: string;
  world: WorldRecord | null;
  packages: PackageSummary[];
  sessionPlugins: SessionPluginInfo[];
  submittedBlockIds: ReadonlySet<string>;
  viewMode: "parsed" | "raw";
  blockSelections: Record<string, string>;
  onSendMessage: (msg: string) => void;
  onSubmitBlock: (blockId: string) => void;
  onRetryRuntime?: (runtimeId: string | undefined) => void;
  onTriggerEvent?: (type: string, data: Record<string, unknown>) => void;
  onBlockSelect: (blockId: string, value: string) => void;
  onBeginAdventure: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// ── Helpers ──────────────────────────────────────────────────────

const INTERACTIVE_BLOCK_TYPES = new Set(["choice_set", "action_guide"]);

// ── Component ────────────────────────────────────────────────────

export function ChatMessages({
  messages,
  executionSteps,
  executionError,
  executing,
  phase,
  world,
  packages,
  sessionPlugins,
  submittedBlockIds,
  viewMode,
  blockSelections,
  onSendMessage,
  onSubmitBlock,
  onRetryRuntime,
  onTriggerEvent,
  onBlockSelect,
  onBeginAdventure,
  messagesEndRef,
}: ChatMessagesProps) {
  const { t } = useTranslation();

  // Whether any plugin with image-generation capability is active in this session
  const isImageGenActive = sessionPlugins.some(
    (p) => p.isActive && p.capabilities?.includes("image-generation"),
  );

  function handleGenerateImage(messageContent: string) {
    if (!onTriggerEvent) return;
    // Truncate to avoid exhausting the enhancement LLM's token budget.
    // The kernel will inject full world + character context automatically.
    const scenePrompt = messageContent.slice(0, 800);
    onTriggerEvent("image.generation.requested", {
      scenePrompt,
      storyBackground: world?.description
        ? (typeof world.description === "string"
            ? world.description
            : Object.values(world.description as Record<string, string>)[0] ?? "")
        : "",
    });
  }

  function renderMessage(msg: StreamMessage) {
    if (msg.block) return renderBlock(msg);

    // Hide non-story assistant messages (plugin output) — same filter as live play
    if (msg.role === "assistant" && msg.kind && msg.kind !== "story") return null;

    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";
    const showImageButton = !isUser && !isSystem && isImageGenActive && msg.content && onTriggerEvent;

    return (
      <div
        key={msg.id}
        className={`flex flex-col gap-1.5 ${isUser ? "items-end" : ""}`}
      >
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {isUser ? "Player" : isSystem ? "System" : "Assistant"}
          {msg.turnId && (
            <span className="ml-2 font-mono text-[10px]">{msg.turnId}</span>
          )}
        </span>
        {viewMode === "parsed" ? (
          <div
            className={`border border-border p-4 text-sm wrap-break-words max-w-[90%] md:max-w-[85%] ${
              isUser
                ? "bg-primary text-primary-foreground"
                : "bg-card text-card-foreground prose prose-sm dark:prose-invert max-w-none"
            }`}
          >
            <Markdown>{msg.content}</Markdown>
          </div>
        ) : (
          <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-w-[90%] md:max-w-[85%]">
            {JSON.stringify(
              { role: msg.role, content: msg.content, turnId: msg.turnId },
              null,
              2,
            )}
          </div>
        )}
        {showImageButton && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1"
              disabled={executing}
              onClick={() => handleGenerateImage(msg.content)}
              title={t("coreImage.generateButton", "生成插画")}
            >
              <ImageIcon className="h-3 w-3" />
              {t("coreImage.generateButton", "生成插画")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  function renderBlock(msg: StreamMessage) {
    const block = msg.block;
    if (!block) return null;
    const blockType = block.type as string;
    const data = block.data as Record<string, unknown> | undefined;
    const Renderer = getBlockRenderer(blockType);

    const hasCustomRenderer = viewMode === "parsed" && Renderer && data;
    const isSubmitted = submittedBlockIds.has(msg.id);
    const blockDisabled = executing || isSubmitted;
    const isInteractive = INTERACTIVE_BLOCK_TYPES.has(blockType);

    // For interactive blocks: use select mode (collect, then confirm together).
    // For non-interactive blocks: direct submit as before.
    const handleBlockSubmit = (value: string) => {
      const submission = resolveBlockSubmission(blockType, value);

      if (submission.kind === "trigger_event") {
        if (onTriggerEvent) {
          onTriggerEvent(submission.eventType, submission.eventData);
        } else {
          onSendMessage(value);
        }
        return;
      }

      onSubmitBlock(msg.id);
      onSendMessage(submission.content);
    };

    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        {!hasCustomRenderer && (
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Block: {blockType}
          </span>
        )}
        {hasCustomRenderer ? (
          <Renderer
            data={data}
            onSubmit={handleBlockSubmit}
            disabled={blockDisabled}
            {...(isInteractive && !isSubmitted
              ? {
                  onSelect: (value: string) => onBlockSelect(msg.id, value),
                  selectedValue: blockSelections[msg.id] ?? null,
                }
              : {})}
          />
        ) : (
          <RawJsonBlock content={JSON.stringify(block, null, 2)} />
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 md:p-6 space-y-6 md:space-y-8 max-w-4xl mx-auto w-full">
        {messages.length === 0 && !executing && (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-6">
            {(phase === "init" || phase === "pre-game") ? (
              <>
                <div className="space-y-2">
                  <p className="text-base font-semibold">{world ? (typeof world.name === "string" ? world.name : (world.name as Record<string, string>)["zh-CN"] ?? "") : ""}</p>
                  <p className="text-sm text-muted-foreground max-w-xs">
                    {t("session.beginAdventureHint", "准备好了吗？点击下方按钮，让故事开始。")}
                  </p>
                </div>
                <Button
                  size="lg"
                  className="px-10 py-5 text-sm uppercase tracking-widest font-bold"
                  onClick={onBeginAdventure}
                >
                  <Flame className="w-4 h-4 mr-2" />
                  {t("session.beginAdventure", "开始冒险")}
                </Button>
              </>
            ) : (
              <>
                <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  {phase === "character_creation" && t("session.emptyCharCreate")}
                  {phase === "playing" && t("session.emptyPlaying")}
                  {phase === "ended" && t("session.emptyEnded")}
                </p>
              </>
            )}
          </div>
        )}

        {/* Render messages with per-turn execution timelines inline */}
        {(() => {
          // Group execution steps by turnId for inline rendering
          const stepsByTurn = new Map<string, ExecutionStep[]>();
          for (const step of executionSteps) {
            const tid = step.turnId ?? "__unknown__";
            if (!stepsByTurn.has(tid)) stepsByTurn.set(tid, []);
            stepsByTurn.get(tid)!.push(step);
          }

          // Collect the last message index per turnId so we know where to insert
          const lastMsgIndexByTurn = new Map<string, number>();
          messages.forEach((msg, idx) => {
            if (msg.turnId) lastMsgIndexByTurn.set(msg.turnId, idx);
          });

          const rendered: React.ReactNode[] = [];
          const insertedTurnIds = new Set<string>();

          messages.forEach((msg, idx) => {
            const node = renderMessage(msg);
            if (node) rendered.push(node);

            // After the last message of a turn, insert that turn's execution timeline
            if (msg.turnId && lastMsgIndexByTurn.get(msg.turnId) === idx) {
              const turnSteps = stepsByTurn.get(msg.turnId);
              if (turnSteps && turnSteps.length > 0) {
                insertedTurnIds.add(msg.turnId);
                const isActiveTurn = executing && msg.turnId === [...lastMsgIndexByTurn.keys()].at(-1);
                rendered.push(
                  <ExecutionTimeline
                    key={`exec-${msg.turnId}`}
                    steps={turnSteps}
                    executing={isActiveTurn ? executing : false}
                    packages={packages}
                    onRetryRuntime={
                      isActiveTurn && onRetryRuntime ? (id) => onRetryRuntime(id) : undefined
                    }
                    onRetryAll={
                      isActiveTurn && onRetryRuntime ? () => onRetryRuntime(undefined) : undefined
                    }
                  />
                );
              }
            }
          });

          // If the current turn is executing and has no messages yet (startup),
          // or steps belong to a turn with no messages, show at the bottom
          const activeTurnSteps = executionSteps.filter((s) => {
            const tid = s.turnId ?? "__unknown__";
            return !insertedTurnIds.has(tid);
          });
          if (activeTurnSteps.length > 0) {
            rendered.push(
              <ExecutionTimeline
                key="exec-active"
                steps={activeTurnSteps}
                executing={executing}
                packages={packages}
                onRetryRuntime={onRetryRuntime ? (id) => onRetryRuntime(id) : undefined}
                onRetryAll={onRetryRuntime ? () => onRetryRuntime(undefined) : undefined}
              />
            );
          }

          return rendered;
        })()}

        {executionError && (
          <div className="flex items-start gap-2 border border-destructive/50 bg-destructive/5 p-4 text-sm">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Error</p>
              <p className="text-xs text-muted-foreground mt-1 break-all">
                {executionError}
              </p>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </ScrollArea>
  );
}

// ── RawJsonBlock ─────────────────────────────────────────────────

function RawJsonBlock({ content }: { content: string }) {
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
