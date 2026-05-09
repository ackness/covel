import { useState, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ImageIcon, MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Markdown } from "@/components/ui/markdown.js";
import { ExecutionTimeline } from "./execution-timeline.js";
import {
  AssetRender,
  AssetTurnSidebar,
} from "@/components/asset-render/index.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import { useSession } from "@/stores/session-store.js";
import { isAssetGenerateView } from "@covel/shared";
import type { PluginRpcRequest } from "@covel/shared";
import { emitToast } from "@/lib/toast-channel.js";
import {
  emitPluginRpcRuntimeResponse,
  postPluginRpcWithApproval,
} from "./plugin-rpc-ui.js";
import {
  BranchReplyBlock,
  hasLaterUserMessage,
  MessageBlockRenderer,
  PluginMessageBlock,
  UiRenderBlock,
} from "./chat-messages/message-blocks.js";
import {
  RawJsonBlock,
  SubmittedSelectionFooter,
  SystemMessageLine,
} from "./chat-messages/message-primitives.js";
import { SessionCanvasHero } from "./chat-messages/session-canvas-hero.js";
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
  /** Form values keyed by submitted block id — used to repopulate disabled forms. */
  submittedBlockValues: Readonly<Record<string, Record<string, unknown>>>;
  viewMode: "parsed" | "detailed" | "raw";
  blockSelections: Record<string, string>;
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
  onTriggerEvent?: (type: string, data: Record<string, unknown>) => void;
  onBlockSelect: (blockId: string, value: string) => void;
  onBeginAdventure: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

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
  submittedBlockValues,
  viewMode,
  blockSelections,
  onSendMessage,
  onSubmitBlock,
  onSubmitInteraction,
  onRetryRuntime,
  onTriggerEvent,
  onBlockSelect,
  onBeginAdventure,
  messagesEndRef,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  const { state: sessionState } = useSession();
  const sessionId = sessionState.session?.id;
  const [generatingImage, setGeneratingImage] = useState(false);
  interface ConfirmRequest {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
    readonly resolve: (value: boolean) => void;
  }
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const confirmRequestRef = useRef<ConfirmRequest | null>(null);
  confirmRequestRef.current = confirmRequest;
  const confirmAsync = useCallback(
    (params: Omit<ConfirmRequest, "resolve">) =>
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

  // Discover the image-gen entry runtime by capability + trigger so this
  // framework code never names a specific plugin or runtime. An entry runtime
  // is one with capability `image-prompt` and a manual trigger — that's the
  // contract authors follow when wiring a multi-step image plugin (prompt
  // generator → image generator chained via background follower).
  const imageGenEntry = useMemo<{
    pluginId: string;
    runtimeId: string;
  } | null>(() => {
    for (const p of sessionPlugins) {
      if (!p.isActive) continue;
      if (!p.capabilities?.includes("image-generation")) continue;
      const entry = p.runtimes?.find(
        (r) =>
          r.trigger?.type === "manual" &&
          r.capabilities?.includes("image-prompt"),
      );
      if (entry) return { pluginId: p.id, runtimeId: entry.id };
    }
    return null;
  }, [sessionPlugins]);

  const isImageGenActive = imageGenEntry !== null;

  // Use plugin-rpc rather than `triggerEvent`. Firing a kernel event would
  // create a fresh turn just to route the topic; plugin-rpc invokes the entry
  // runtime in-place and lets the framework dispatch its background follower
  // (image generator) without inflating the turn counter. The plugin's right-
  // panel button uses the same pattern — keep them aligned.
  async function handleGenerateImage() {
    if (!sessionId || !imageGenEntry || generatingImage) return;
    const req = {
      pluginId: imageGenEntry.pluginId,
      runtimeId: imageGenEntry.runtimeId,
      expectsBackgroundFollower: true,
    } satisfies PluginRpcRequest;
    setGeneratingImage(true);
    try {
      const res = await postPluginRpcWithApproval({
        sessionId,
        request: req,
        pluginId: imageGenEntry.pluginId,
        actionLabel: `runtime ${imageGenEntry.runtimeId}`,
        confirm: confirmAsync,
        t,
      });
      if (res) {
        emitPluginRpcRuntimeResponse({
          response: res,
          t,
          runtimeId: imageGenEntry.runtimeId,
          expectsBackgroundFollower: true,
          fallbackFailureMessage: "Image generation failed",
        });
      }
    } catch (err) {
      emitToast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingImage(false);
    }
  }

  /**
   * Visibility rules per view mode:
   *   parsed   — user/narrative/plugin-inline only. System + debug kinds hidden.
   *   detailed — everything parsed shows, PLUS system messages as compact one-liners.
   *              Raw JSON / internal LLM trace stays hidden.
   *   raw      — show every message as JSON for inspection.
   */
  function renderMessage(msg: StreamMessage) {
    if (msg.block) return renderBlock(msg);

    // Raw mode: show everything as JSON, no filtering
    if (viewMode === "raw") {
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
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
      return <SystemMessageLine key={msg.id} msg={msg} />;
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
        key={msg.id}
        className={`ui-message-row flex flex-col gap-1.5 w-full ${isUser ? "items-end" : "items-start"}`}
      >
        {showSourceBadge && (
          <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
            {msg.runtimeId ?? "assistant"}
            {msg.kind && msg.kind !== "story" && (
              <span className="ml-1.5 opacity-60">· {msg.kind}</span>
            )}
          </span>
        )}
        <span
          className={`ui-eyebrow text-xs ${isUser ? "text-primary" : "text-muted-foreground"}`}
        >
          {isUser ? "Player" : "Assistant"}
          {msg.turnId && (
            <span className="ml-2 font-mono text-[10px]">
              {isUser ? `· ${msg.turnId}` : msg.turnId}
            </span>
          )}
        </span>

        <div
          className={`text-sm wrap-break-words w-full ${
            isUser
              ? "ui-message-player max-w-[90%] md:max-w-[85%] border border-border p-4"
              : isHiddenAssistantKind
                ? "ui-message-assistant max-w-none border-l-2 border-border/40 pl-3 py-1 font-mono text-[12px] text-muted-foreground/80 whitespace-pre-wrap"
                : "ui-message-assistant ui-narrative prose prose-sm max-w-none border-0 p-0"
          }`}
        >
          {isUser ? (
            <p className="m-0 text-[14px] leading-[1.6]">{msg.content}</p>
          ) : isHiddenAssistantKind ? (
            // Plugin/debug kinds in detailed view — preserve the raw text so
            // the structure of what the runtime emitted is visible, but skip
            // the narrative-prose styling to signal "this is not story".
            msg.content
          ) : (
            <Markdown>{msg.content}</Markdown>
          )}
        </div>

        {showImageButton && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1 ui-eyebrow"
              disabled={executing || generatingImage}
              onClick={() => void handleGenerateImage()}
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

  function renderBlock(msg: StreamMessage) {
    const block = msg.block;
    if (!block) return null;

    // Raw mode — show JSON for inspection.
    if (viewMode === "raw") {
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Block: {block.type as string}
          </span>
          <RawJsonBlock content={JSON.stringify(block, null, 2)} />
        </div>
      );
    }

    const blockType = block.type as string;
    const submittedValues = submittedBlockValues[msg.id];

    // Plugin-message surface: plugins push json-render specs via ui.message
    // and state via plugin-data namespace=message. Each spec runs through
    // PluginPanel, which reads the live plugin-data store for reactive state.
    if (blockType === "plugin_message") {
      const pluginId =
        ((block.data as Record<string, unknown> | undefined)?.pluginId as
          | string
          | undefined) ?? msg.runtimeId;
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          {viewMode === "detailed" && pluginId && (
            <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
              plugin · {pluginId}
            </span>
          )}
          <PluginMessageBlock
            block={block}
            sourceBlockId={msg.id}
            locked={hasLaterUserMessage(msg, messages)}
          />
          <SubmittedSelectionFooter values={submittedValues} />
        </div>
      );
    }

    if (blockType === "ui.render") {
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          {viewMode === "detailed" && (
            <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
              ui.render
              {msg.runtimeId && (
                <span className="ml-1.5 opacity-60">· {msg.runtimeId}</span>
              )}
            </span>
          )}
          <UiRenderBlock block={block} />
        </div>
      );
    }

    if (blockType === "branch_reply" || blockType === "branch-reply") {
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          {viewMode === "detailed" && (
            <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
              branch-reply
              {msg.runtimeId && (
                <span className="ml-1.5 opacity-60">· {msg.runtimeId}</span>
              )}
            </span>
          )}
          <BranchReplyBlock block={block} />
          <SubmittedSelectionFooter values={submittedValues} />
        </div>
      );
    }

    const assetView = isAssetGenerateView(block.data) ? block.data : null;
    if (blockType === "asset.generate" && sessionId && assetView) {
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          {viewMode === "detailed" && (
            <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
              asset · {assetView.modality}
            </span>
          )}
          <AssetRender view={assetView} sessionId={sessionId} />
        </div>
      );
    }

    // Every other block (interactive_form, notification, choice, …) resolves
    // through messageToSpec and json-render.
    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        {viewMode === "detailed" && (msg.runtimeId || blockType) && (
          <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
            {blockType ? `block · ${blockType}` : "block"}
            {msg.runtimeId && (
              <span className="ml-1.5 opacity-60">· {msg.runtimeId}</span>
            )}
          </span>
        )}
        <MessageBlockRenderer
          msg={msg}
          block={block}
          submitted={
            submittedBlockIds.has(msg.id) || hasLaterUserMessage(msg, messages)
          }
          submittedValues={submittedValues}
          executing={executing}
          onSubmitInteraction={onSubmitInteraction}
          onSendMessage={onSendMessage}
          onSubmitBlock={onSubmitBlock}
        />
        <SubmittedSelectionFooter values={submittedValues} />
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="flex-1 min-h-0">
        <div className="ui-session-column p-4 md:p-6 space-y-6 md:space-y-7 mx-auto w-full">
          {messages.length === 0 &&
            !executing &&
            // Empty-state rendering no longer depends on the historical
            // `pre-game` / `character_creation` / `playing` enum. After the
            // turn-band migration the session is fully described by
            // `status + turnCount + preGameCompleted`; here we only need the
            // derived `LegacyPhase` (`init` / `playing` / `paused` / `ended`)
            // to choose between the "begin adventure" CTA and the post-start
            // empty message.
            (phase === "init" ? (
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
                  {phase === "playing" && t("session.emptyPlaying")}
                  {phase === "ended" && t("session.emptyEnded")}
                </p>
              </div>
            ))}

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
                  const isActiveTurn =
                    executing &&
                    msg.turnId === [...lastMsgIndexByTurn.keys()].at(-1);
                  rendered.push(
                    <ExecutionTimeline
                      key={`exec-${msg.turnId}`}
                      steps={turnSteps}
                      executing={isActiveTurn ? executing : false}
                      packages={packages}
                      onRetryRuntime={
                        isActiveTurn && onRetryRuntime
                          ? (id) => onRetryRuntime(id)
                          : undefined
                      }
                      onRetryAll={
                        isActiveTurn && onRetryRuntime
                          ? () => onRetryRuntime(undefined)
                          : undefined
                      }
                    />,
                  );
                }
                // P0-b — surface modality-routed assets emitted by this turn
                // out-of-band, so plain narrative turns stay untouched while
                // image / audio / generic-link assets show up next to the
                // execution timeline. Renders nothing when the turn has no
                // assets, so this is a layout no-op for text-only turns.
                rendered.push(
                  <AssetTurnSidebar
                    key={`assets-${msg.turnId}`}
                    turnId={msg.turnId}
                  />,
                );
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
                  onRetryRuntime={
                    onRetryRuntime ? (id) => onRetryRuntime(id) : undefined
                  }
                  onRetryAll={
                    onRetryRuntime ? () => onRetryRuntime(undefined) : undefined
                  }
                />,
              );
            }

            return rendered;
          })()}

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

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
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
