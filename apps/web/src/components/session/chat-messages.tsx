import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowDown, Loader2, MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Button } from "@/components/ui/button.js";
import { useAutoScroll } from "@/hooks/use-auto-scroll.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import { useSession } from "@/stores/session-store.js";
import { subscribeToStreamingChanges } from "@/stores/streaming-text-store.js";
import { SessionCanvasHero } from "./chat-messages/session-canvas-hero.js";
import { ChatMessageRenderer } from "./chat-messages/chat-message-renderer.js";
import { ChatBlockRenderer } from "./chat-messages/chat-block-renderer.js";
import { useImageGeneration } from "./chat-messages/use-image-generation.js";
import { useLoadOlderMessages } from "./chat-messages/use-load-older-messages.js";
import { useMessageGrouping } from "./chat-messages/use-message-grouping.js";
import { isPreGameSession } from "@/stores/session-store/selectors.js";
import type { PluginRpcConfirmRequest } from "./plugin-rpc-ui.js";
import type {
  WorldRecord,
  PackageSummary,
  SessionRecord,
  SessionPluginInfo,
} from "@/services/api.js";

// ── Types ────────────────────────────────────────────────────────

export interface ChatMessagesProps {
  messages: StreamMessage[];
  executionSteps: ExecutionStep[];
  executionError: string | null;
  executing: boolean;
  session: SessionRecord;
  world: WorldRecord | null;
  packages: PackageSummary[];
  sessionPlugins: SessionPluginInfo[];
  submittedBlockIds: ReadonlySet<string>;
  /** Form values keyed by submitted block id — used to repopulate disabled forms. */
  submittedBlockValues: Readonly<Record<string, Record<string, unknown>>>;
  viewMode: "parsed" | "detailed" | "raw" | "stage";
  onSendMessage: (msg: string) => void;
  onSubmitBlock: (blockId: string) => void;
  onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  onRetryRuntime?: (runtimeId: string | undefined) => void;
  onBeginAdventure: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

interface ConfirmRequest extends PluginRpcConfirmRequest {
  readonly resolve: (value: boolean) => void;
}

// ── Component ────────────────────────────────────────────────────

export function ChatMessages({
  messages,
  executionSteps,
  executionError,
  executing,
  session,
  world,
  packages,
  sessionPlugins,
  submittedBlockIds,
  submittedBlockValues,
  viewMode,
  onSendMessage,
  onSubmitBlock,
  onSubmitInteraction,
  onRetryRuntime,
  onBeginAdventure,
  messagesEndRef,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  const { state: sessionState, loadOlderMessages } = useSession();
  const sessionId = sessionState.session?.id;
  // Sticky-bottom auto-scroll. Follows the stream only while the user is
  // pinned to the bottom; surfaces a "jump to latest" button after they
  // scroll up. The Radix ScrollArea renders its scrollable element as the
  // [data-radix-scroll-area-viewport] node, so we resolve it from the root.
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  // 解析出的滚动视口。除自动滚动外，向上加载更旧消息的 IntersectionObserver
  // 与滚动补偿也需要它，故存入 state 以便相关 effect 在其就绪后重新运行。
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  // Autoscroll follows both new messages and the external streaming signal;
  // token arrival does not re-render this history-sized parent component.
  const { scrollRef, bottomRef, showJumpButton, jumpToBottom } = useAutoScroll(
    messages.length,
    {
      subscribeToStreaming: subscribeToStreamingChanges,
    },
  );
  useEffect(() => {
    const root = scrollRootRef.current;
    const viewport =
      root?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ??
      null;
    setViewportEl(viewport);
    scrollRef(viewport);
    return () => scrollRef(null);
  }, [scrollRef]);

  // 向上滚动加载更旧消息（游标分页）。顶部 sentinel 进入视口即预取一页，
  // 合并后按 scrollHeight 差值补偿 scrollTop 保持视图不跳。
  const { topSentinelRef, loadingOlder } = useLoadOlderMessages({
    viewportEl,
    hasOlder: sessionState.olderMessagesCursor != null,
    firstMessageId: messages[0]?.id,
    onLoadOlder: loadOlderMessages,
  });
  const isPreGame = isPreGameSession(session);
  const isPlaying = session.status === "active" && session.turnCount > 0;
  const isEnded = session.status === "ended";

  // Confirmation dialog state. The in-flight request carries its own `resolve`.
  // A ref mirrors the latest request so `handleConfirmResult` can resolve it
  // *outside* the state updater — resolving inside a `setState` updater is a
  // React anti-pattern (StrictMode invokes updaters twice, double-resolving the
  // promise). Mirrors the ref pattern used in PluginPanel.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const confirmRequestRef = useRef<ConfirmRequest | null>(null);
  confirmRequestRef.current = confirmRequest;
  const confirmAsync = useCallback(
    (params: PluginRpcConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest({ ...params, resolve });
      }),
    [],
  );
  const handleConfirmResult = useCallback((value: boolean) => {
    const current = confirmRequestRef.current;
    if (!current) return;
    current.resolve(value);
    setConfirmRequest(null);
  }, []);

  const { isImageGenActive, generatingImage, handleGenerateImage } =
    useImageGeneration({ sessionPlugins, sessionId, confirm: confirmAsync, t });

  // Precompute the index of the last user message once (O(n)). An interactive
  // block is "locked" iff a later user message exists, i.e. its index is below
  // the last user index — an O(1) check that replaces the previous per-block
  // O(n) scan (which made block rendering O(n²) across the whole list).
  const lastUserMsgIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }, [messages]);

  // ChatMessages accepts "stage" only so GameViewHeader's viewMode type-checks
  // when passed through (game-view swaps ChatMessages out entirely in stage
  // mode); the per-message renderers below only know parsed/detailed/raw.
  const renderViewMode = viewMode === "stage" ? "parsed" : viewMode;

  const renderMessage = useCallback(
    (msg: StreamMessage, index: number) => {
      if (msg.block) {
        return (
          <ChatBlockRenderer
            key={msg.id}
            msg={msg}
            index={index}
            viewMode={renderViewMode}
            lastUserMsgIndex={lastUserMsgIndex}
            sessionId={sessionId}
            executing={executing}
            submittedBlockIds={submittedBlockIds}
            submittedBlockValues={submittedBlockValues}
            onSendMessage={onSendMessage}
            onSubmitBlock={onSubmitBlock}
            onSubmitInteraction={onSubmitInteraction}
            t={t}
          />
        );
      }
      return (
        <ChatMessageRenderer
          key={msg.id}
          msg={msg}
          viewMode={renderViewMode}
          isImageGenActive={isImageGenActive}
          sessionId={sessionId}
          executing={executing}
          generatingImage={generatingImage}
          onGenerateImage={() => void handleGenerateImage()}
          t={t}
        />
      );
    },
    [
      renderViewMode,
      lastUserMsgIndex,
      sessionId,
      executing,
      submittedBlockIds,
      submittedBlockValues,
      onSendMessage,
      onSubmitBlock,
      onSubmitInteraction,
      isImageGenActive,
      generatingImage,
      handleGenerateImage,
      t,
    ],
  );

  const renderedRows = useMessageGrouping({
    messages,
    executionSteps,
    executing,
    packages,
    onRetryRuntime,
    renderMessage,
  });

  return (
    <>
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ScrollArea ref={scrollRootRef} className="flex-1 min-h-0">
          <div className="ui-session-column p-4 md:p-6 space-y-6 md:space-y-7 mx-auto w-full">
            {/* 顶部哨兵（零高度）：进入视口触发游标分页向上加载。放在滚动内容流内，
                但不产生高度，避免影响加载后的 scrollHeight 差值补偿。 */}
            <div ref={topSentinelRef} aria-hidden="true" />

            {messages.length === 0 &&
              !executing &&
              (isPreGame ? (
                <SessionCanvasHero
                  world={world}
                  onBegin={onBeginAdventure}
                  beginLabel={t("session.beginAdventure")}
                  hintLabel={t("session.beginAdventureHint")}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center space-y-6">
                  <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {isPlaying && t("session.emptyPlaying")}
                    {isEnded && t("session.emptyEnded")}
                  </p>
                </div>
              ))}

            {/* Render messages with per-turn execution timelines inline */}
            {renderedRows}

            {executionError && (
              <div className="flex items-start gap-2 border border-destructive/50 bg-destructive/5 p-4 text-sm">
                <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-destructive">
                    {t("common.error", "Error")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 break-all">
                    {executionError}
                  </p>
                </div>
              </div>
            )}

            <div
              ref={(node) => {
                bottomRef.current = node;
                messagesEndRef.current = node;
              }}
            />
          </div>
        </ScrollArea>
        {/* 加载更旧消息指示：绝对定位悬浮，不进入滚动内容流，避免扰动 scrollHeight
            补偿计算（否则会在加载前后产生额外跳动）。 */}
        {loadingOlder && (
          <div className="pointer-events-none absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("session.loadingOlder", "Loading earlier messages…")}
          </div>
        )}
        {showJumpButton && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={jumpToBottom}
            aria-label={t("session.jumpToLatest", "Jump to latest")}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 h-8 gap-1.5 rounded-full px-3 shadow-md"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {t("session.jumpToLatest", "Jump to latest")}
          </Button>
        )}
      </div>
      <Dialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open) handleConfirmResult(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmRequest?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line pt-1">
              {confirmRequest?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleConfirmResult(false)}
            >
              {confirmRequest?.cancelLabel}
            </Button>
            <Button size="sm" onClick={() => handleConfirmResult(true)}>
              {confirmRequest?.confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
