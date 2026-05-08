import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Flame,
  ImageIcon,
  MessageSquare,
  Settings2,
} from "lucide-react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
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
import { covelRegistry, resolveI18n } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
import { PluginPanel } from "./plugin-panel.js";
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

// ── Plugin-message block ────────────────────────────────────────
//
// When the server synthesizes a `plugin_message` block from plugin-data on
// namespace="message", we get:
//   block.data.pluginId  — which plugin authored the surface
//   block.data.specs     — json-render specs from the plugin manifest (ui.message[])
//   block.data.state     — current plugin-data snapshot (stripped of __private keys)
//
// Each spec is rendered by PluginPanel, which reads the live plugin-data
// store (so subsequent changes trigger reactive re-renders without waiting
// for another synthesized block).
function PluginMessageBlock({
  block,
  sourceBlockId,
  locked,
}: {
  block: Record<string, unknown>;
  /** StreamMessage id of the surrounding block, used to attribute drafts back to their source. */
  sourceBlockId: string;
  locked: boolean;
}) {
  const { sendMessage, upsertInteractionDraft, setComposerText } = useSession();
  const data = (block.data ?? {}) as Record<string, unknown>;
  const pluginId = data.pluginId as string;
  const specs = (data.specs ?? []) as Array<Record<string, unknown>>;
  const state = (data.state ?? {}) as Record<string, unknown>;
  const turnId =
    ((block.meta as Record<string, unknown> | undefined)?.turnId as
      | string
      | undefined) ?? "";

  const handlers = useMemo(
    () => ({
      draftMessage: async (params: Record<string, unknown>) => {
        if (locked) return;
        const text = String(params.text ?? "").trim();
        if (!text) return;
        const selectionGroup =
          typeof params.selectionGroup === "string"
            ? params.selectionGroup
            : undefined;
        const sourceKey = turnId || sourceBlockId;
        upsertInteractionDraft({
          id: selectionGroup
            ? `${sourceKey}:${selectionGroup}`
            : `plugin-draft:${sourceBlockId}:${text}`,
          turnId: sourceKey,
          interactionId: selectionGroup ?? `plugin-draft:${text}`,
          type: "suggestion",
          label: text,
          values: { text },
          sourceBlockId,
          selectionGroup,
        });
      },
      sendMessage: async (params: Record<string, unknown>) => {
        if (locked) return;
        const text = String(params.text ?? "").trim();
        if (!text) return;
        sendMessage(text);
      },
      setComposerText: async (params: Record<string, unknown>) => {
        if (locked) return;
        setComposerText(String(params.text ?? ""));
      },
    }),
    [locked, turnId, sendMessage, upsertInteractionDraft, setComposerText],
  );

  if (!pluginId || specs.length === 0) return null;

  return (
    <div className="space-y-3">
      {specs.map((spec, index) => (
        <PluginPanel
          key={`${pluginId}:${turnId}:${index}`}
          pluginId={pluginId}
          spec={spec}
          stateOverride={state}
          interactionLocked={locked}
          handlers={handlers}
        />
      ))}
    </div>
  );
}

function UiRenderBlock({ block }: { block: Record<string, unknown> }) {
  const data = (block.data ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(data.parts) ? data.parts : [];
  if (parts.length === 0) return null;

  return (
    <div className="space-y-2">
      {parts.map((raw, index) => {
        const part =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {};
        const content = part.content;
        const spec = uiPartToSpec(part.type, content);
        if (!spec) return null;
        return (
          <div key={typeof part.id === "string" ? part.id : index}>
            <JSONUIProvider
              registry={covelRegistry}
              initialState={{}}
              handlers={{}}
            >
              <Renderer spec={nestedToFlat(spec)} registry={covelRegistry} />
            </JSONUIProvider>
          </div>
        );
      })}
    </div>
  );
}

function uiPartToSpec(
  type: unknown,
  content: unknown,
): Record<string, unknown> | null {
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const nested =
      obj.spec && typeof obj.spec === "object"
        ? (obj.spec as Record<string, unknown>)
        : obj.component || obj.type
          ? obj
          : null;
    if (nested) return normalizeNestedSpec(nested);
  }

  if (typeof content === "string" && content.trim()) {
    return { type: "Text", props: { content } };
  }

  return {
    type: "JsonView",
    props: { value: { type, content } },
  };
}

function normalizeNestedSpec(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "component") out.type = value;
    else if (key === "children" && Array.isArray(value)) {
      out.children = value.map((child) =>
        child && typeof child === "object"
          ? normalizeNestedSpec(child as Record<string, unknown>)
          : child,
      );
    } else out[key] = value;
  }
  return out;
}

function BranchReplyBlock({ block }: { block: Record<string, unknown> }) {
  const data = (block.data ?? block) as Record<string, unknown>;
  const spec = useMemo(
    () =>
      nestedToFlat({
        type: "BranchReplyCandidates",
        props: {
          value: data,
          pluginId: "branch-reply",
        },
      }),
    [data],
  );

  return (
    <JSONUIProvider registry={covelRegistry} initialState={{}} handlers={{}}>
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
  );
}

// ── MessageBlockRenderer ────────────────────────────────────────
//
// Renders any block other than plugin_message using message-to-spec +
// json-render. Form/choice handlers bridge into onSubmitInteraction so
// the existing submit-inputs API + echoFilledNarrative UX hint keeps
// working exactly as before.
function MessageBlockRenderer({
  msg,
  block,
  submitted,
  submittedValues,
  executing,
  onSubmitInteraction,
  onSendMessage,
  onSubmitBlock,
}: {
  msg: StreamMessage;
  block: Record<string, unknown>;
  submitted: boolean;
  /** Persisted form values for this block, used to repopulate disabled forms. */
  submittedValues?: Record<string, unknown>;
  executing: boolean;
  onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  onSendMessage: (msg: string) => void;
  onSubmitBlock: (blockId: string) => void;
}) {
  const { upsertInteractionDraft } = useSession();
  const formStateRef = useRef<Record<string, unknown>>({});

  const effectiveSubmitted = submitted;
  const spec = useMemo(() => {
    const nested = effectiveSubmitted
      ? messageToSpecDisabled(msg, submittedValues)
      : messageToSpec(msg);
    if (!nested) return null;
    try {
      return nestedToFlat(nested);
    } catch {
      return null;
    }
  }, [msg, effectiveSubmitted, submittedValues]);

  const handleStateChange = useCallback(
    (changes: Array<{ path: string; value: unknown }>) => {
      for (const { path, value } of changes) {
        formStateRef.current[path] = value;
      }
    },
    [],
  );

  const readBlockMeta = useCallback(() => {
    const data = (block.data ?? block) as Record<string, unknown>;
    const meta = (block.meta ?? {}) as Record<string, unknown>;
    const interactionId =
      (data.interactionId as string | undefined) ??
      (data.formId as string | undefined) ??
      "form";
    const turnId = (meta.turnId as string | undefined) ?? msg.turnId ?? "";
    const rawBehavior = data.submitBehavior as
      | Record<string, unknown>
      | undefined;
    const submitBehavior = rawBehavior
      ? {
          echoFilledNarrative: rawBehavior.echoFilledNarrative as
            | boolean
            | undefined,
        }
      : undefined;
    return { data, turnId, interactionId, submitBehavior };
  }, [block, msg.turnId]);

  const handlers = useMemo(
    () => ({
      submitForm: async () => {
        if (effectiveSubmitted) return;
        const { data, turnId, interactionId, submitBehavior } = readBlockMeta();

        // Extract form field values from json-render state tree (/form/<name>).
        const formValues: Record<string, string> = {};
        for (const [path, value] of Object.entries(formStateRef.current)) {
          const match = path.match(/^\/form\/(.+)$/);
          if (match && value != null) {
            formValues[match[1]] = String(value);
          }
        }

        const fields =
          (data.fields as
            | Array<{ name?: string; required?: boolean }>
            | undefined) ?? [];
        const missingRequired = fields.some((field) => {
          if (!field?.required || !field.name) return false;
          return !formValues[field.name]?.trim();
        });
        if (missingRequired) return;

        if (onSubmitInteraction && turnId) {
          await onSubmitInteraction(
            msg.id,
            turnId,
            interactionId,
            "form",
            formValues,
            submitBehavior,
          );
        } else {
          // Fallback: submit-inputs unavailable → legacy path with stringified payload
          onSubmitBlock(msg.id);
          onSendMessage(JSON.stringify(formValues));
        }
      },
      selectChoice: async (params: Record<string, unknown>) => {
        if (effectiveSubmitted) return;
        const { turnId, interactionId, submitBehavior } = readBlockMeta();
        const label = params.label as string;
        if (!label) return;
        upsertInteractionDraft({
          id: `${turnId || "choice"}:${interactionId}`,
          turnId: turnId || "choice",
          interactionId,
          type: "choice",
          label,
          values: {
            selectedId: params.choiceId,
            selectedLabel: label,
          },
          sourceBlockId: msg.id,
          submitBehavior,
        });
      },
      selectSuggestion: async (params: Record<string, unknown>) => {
        const text = params.text as string;
        if (!text) return;
        const selectionGroup =
          typeof params.selectionGroup === "string"
            ? params.selectionGroup
            : undefined;
        upsertInteractionDraft({
          id: selectionGroup
            ? `${msg.turnId ?? "suggestion"}:${selectionGroup}`
            : `suggestion:${text}`,
          turnId: msg.turnId ?? "suggestion",
          interactionId: selectionGroup ?? `suggestion:${text}`,
          type: "suggestion",
          label: text,
          values: { text },
          sourceBlockId: msg.id,
          selectionGroup,
        });
      },
      sendCustomAction: async (params: Record<string, unknown>) => {
        const text = String(params.text ?? "").trim();
        if (!text) return;
        onSendMessage(text);
      },
    }),
    [
      effectiveSubmitted,
      readBlockMeta,
      msg.id,
      msg.turnId,
      onSubmitInteraction,
      onSendMessage,
      onSubmitBlock,
      upsertInteractionDraft,
    ],
  );

  if (!spec) {
    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          Block: {block.type as string}
        </span>
        <RawJsonBlock content={JSON.stringify(block, null, 2)} />
      </div>
    );
  }

  return (
    <div
      key={msg.id}
      className={effectiveSubmitted || executing ? "opacity-80" : undefined}
      aria-disabled={effectiveSubmitted || executing}
    >
      <JSONUIProvider
        registry={covelRegistry}
        initialState={
          effectiveSubmitted && submittedValues ? { form: submittedValues } : {}
        }
        handlers={handlers}
        onStateChange={handleStateChange}
      >
        <Renderer spec={spec} registry={covelRegistry} />
      </JSONUIProvider>
    </div>
  );
}

// Locked-after-user-message helper. Once the player sends the next message,
// any previous interactive block is considered resolved and should render in
// disabled state — mirrors V2's `hasLaterUserMessage` / messageToSpecDisabled
// coupling.
function hasLaterUserMessage(
  msg: StreamMessage,
  all: StreamMessage[],
): boolean {
  const idx = all.findIndex((m) => m.id === msg.id);
  if (idx < 0) return false;
  for (let i = idx + 1; i < all.length; i += 1) {
    if (all[i].role === "user") return true;
  }
  return false;
}

// ── SubmittedSelectionFooter ─────────────────────────────────────
//
// Shown beneath any interactive block once the player has submitted/confirmed
// a selection through the draft bar. Generic across block types — it reads
// `_label` from the persisted submitted-block values map and renders a
// muted "玩家选择：xxx" line. Forms intentionally don't store `_label`
// (their values are baked back into the disabled spec instead), so this
// component renders nothing for them.
function SubmittedSelectionFooter({
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

// ── SystemMessageLine ────────────────────────────────────────────
//
// Detailed-view affordance: renders a single system message as a compact
// one-liner with an expand toggle. Lets curious players see "the narrator
// ran / plugin X emitted Y" without drowning in JSON. Stays quiet in
// parsed mode (hidden entirely) and is superseded by the full JSON dump
// in raw mode.
function SystemMessageLine({ msg }: { msg: StreamMessage }) {
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
          {summary || <span className="italic opacity-60">system</span>}
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

// ── SessionCanvasHero ───────────────────────────────────────────────
// Editorial opening view rendered when a session is loaded but no turn has
// run yet. Pulls `openingHook` / `openingChips` from the world's starting
// conditions; falls back to `world.name` and the world tags when those are
// absent, so older world packages keep working unchanged.

interface SessionCanvasHeroProps {
  world: WorldRecord | null;
  onBegin: () => void;
  beginLabel: string;
  hintLabel: string;
}

function SessionCanvasHero({
  world,
  onBegin,
  beginLabel,
  hintLabel,
}: SessionCanvasHeroProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  const worldName = world ? resolveI18n(world.name, locale) : "";
  const start = world?.dimensions?.startingConditions;
  const hook = start?.openingHook
    ? resolveI18n(start.openingHook, locale)
    : worldName;
  const chips: string[] = (() => {
    if (start?.openingChips && start.openingChips.length > 0) {
      return start.openingChips
        .map((chip) => resolveI18n(chip, locale))
        .filter((s) => s.length > 0);
    }
    if (world?.tags && world.tags.length > 0) {
      return world.tags.slice(0, 3).map((tag) => String(tag));
    }
    return [];
  })();
  const summary = world ? resolveI18n(world.description, locale) : "";

  return (
    <div className="ui-session-canvas py-8 md:py-12 max-w-3xl mx-auto px-1">
      {/* Eyebrow + chip row — editorial "kicker" */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <span className="ui-eyebrow">§ SESSION CANVAS</span>
        {chips.map((chip, i) => (
          <span key={`${chip}-${i}`} className="ui-chip text-[10px]">
            {chip}
          </span>
        ))}
      </div>

      {/* Display title — the chosen hook or the world name */}
      <h2
        className="ui-title text-2xl md:text-[2.25rem] leading-tight tracking-tight mb-4"
        style={{ textWrap: "balance" } as React.CSSProperties}
      >
        {hook || hintLabel}
      </h2>

      {/* Body copy — fall back to summary, then to the i18n hint */}
      {(summary || hintLabel) && (
        <p className="ui-empty-copy text-sm md:text-base leading-relaxed mb-6 not-italic text-muted-foreground">
          {summary || hintLabel}
        </p>
      )}

      <Button
        size="lg"
        className="px-8 py-5 text-sm uppercase tracking-widest font-bold"
        onClick={onBegin}
      >
        <Flame className="w-4 h-4 mr-2" />
        {beginLabel}
      </Button>
    </div>
  );
}
