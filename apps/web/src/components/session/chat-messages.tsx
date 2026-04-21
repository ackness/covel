import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Copy,
  Check,
  Flame,
  ImageIcon,
  MessageSquare,
} from "lucide-react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Button } from "@/components/ui/button.js";
import { Markdown } from "@/components/ui/markdown.js";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
import { PluginPanel } from "./plugin-panel.js";
import { ExecutionTimeline } from "./execution-timeline.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import { useSession } from "@/stores/session-store.js";
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
  viewMode: "parsed" | "raw";
  blockSelections: Record<string, string>;
  onSendMessage: (msg: string) => void;
  onSubmitBlock: (blockId: string) => void;
  onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: 'form' | 'choice' | 'confirmation',
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

  /**
   * Visibility rules for parsed (game) mode:
   *   - user messages → always visible
   *   - assistant + kind=story → narrative, visible
   *   - assistant + kind=plugin-message → plugin inline output, visible
   *   - assistant + block → delegated to renderBlock()
   *   - system messages → hidden (framework context, plugin system output)
   *   - assistant + other kind (e.g. "plugin") → hidden (debug only)
   *
   * Raw mode shows ALL messages as JSON for inspection.
   */
  function renderMessage(msg: StreamMessage) {
    if (msg.block) return renderBlock(msg);

    // Raw mode: show everything as JSON, no filtering
    if (viewMode === "raw") {
      return (
        <div
          key={msg.id}
          className="flex flex-col gap-1.5"
        >
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            {msg.role}
            {msg.kind && <span className="ml-1.5 text-[10px] font-mono opacity-60">[{msg.kind}]</span>}
            {msg.runtimeId && <span className="ml-1.5 text-[10px] font-mono opacity-60">{msg.runtimeId}</span>}
            {msg.turnId && <span className="ml-2 font-mono text-[10px]">{msg.turnId}</span>}
          </span>
          <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-w-[90%] md:max-w-[85%]">
            {JSON.stringify(
              { role: msg.role, kind: msg.kind, runtimeId: msg.runtimeId, content: msg.content, turnId: msg.turnId },
              null,
              2,
            )}
          </div>
        </div>
      );
    }

    // Parsed mode: filter out non-player-facing messages
    // System messages are framework internals — never shown in game view
    if (msg.role === "system") return null;
    // Assistant messages: only show narrative (story) and plugin inline output
    if (msg.role === "assistant" && msg.kind && msg.kind !== "story" && msg.kind !== "plugin-message") return null;

    const isUser = msg.role === "user";
    const showImageButton = !isUser && isImageGenActive && msg.content && onTriggerEvent;

    return (
      <div
        key={msg.id}
        className={`flex flex-col gap-1.5 paper:gap-1.5 ${isUser ? "items-end paper:items-start paper:w-full" : "paper:w-full"}`}
      >
        {/* Eyebrow label — Modern: small uppercase; Paper: mono eyebrow tinted primary for user */}
        <span
          className={
            "text-xs text-muted-foreground uppercase tracking-wider font-semibold " +
            "paper:font-mono paper:text-[10px] paper:tracking-[0.12em] " +
            (isUser ? "paper:text-[color:var(--color-primary)]" : "paper:text-muted-foreground")
          }
        >
          {isUser ? "Player" : "Assistant"}
          {msg.turnId && (
            <span className="ml-2 font-mono text-[10px] paper:text-[10px]">
              {isUser ? `· ${msg.turnId}` : msg.turnId}
            </span>
          )}
        </span>

        <div
          className={
            "text-sm wrap-break-words max-w-[90%] md:max-w-[85%] " +
            "paper:max-w-none paper:w-full paper:p-0 paper:bg-transparent paper:text-foreground " +
            (isUser
              ? "border border-border p-4 bg-primary text-primary-foreground " +
                // Paper user turn: bare, left-aligned, 2px accent bar on the left
                "paper:border-0 paper:border-l-2 paper:border-l-[color:var(--color-primary)] paper:pl-3.5 paper:py-0"
              : "border border-border p-4 bg-card text-card-foreground prose prose-sm dark:prose-invert max-w-none " +
                // Paper assistant narrative: iA Writer style — no card, centered column, serif 18/1.78/300
                "paper:border-0 paper:bg-transparent paper:text-foreground paper:p-0 paper-narrative paper:max-w-[42rem] paper:mx-0")
          }
        >
          {isUser ? (
            <p className="paper:font-sans paper:text-[14px] paper:leading-[1.6] paper:text-foreground m-0">
              {msg.content}
            </p>
          ) : (
            <Markdown>{msg.content}</Markdown>
          )}
        </div>

        {showImageButton && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1 paper:font-mono paper:tracking-[0.08em]"
              disabled={executing}
              onClick={() => handleGenerateImage(msg.content)}
              title={t("coreImage.generateButton")}
            >
              <ImageIcon className="h-3 w-3" />
              {t("coreImage.generateButton")}
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
      return (
        <div key={msg.id} className="flex flex-col gap-1.5">
          <PluginMessageBlock
            block={block}
            sourceBlockId={msg.id}
            locked={hasLaterUserMessage(msg, messages)}
          />
          <SubmittedSelectionFooter values={submittedValues} />
        </div>
      );
    }

    // Every other block (interactive_form, notification, choice, …) resolves
    // through messageToSpec and json-render.
    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        <MessageBlockRenderer
          msg={msg}
          block={block}
          submitted={submittedBlockIds.has(msg.id) || hasLaterUserMessage(msg, messages)}
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
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 md:p-6 space-y-6 md:space-y-8 max-w-4xl mx-auto w-full paper:max-w-[42rem] paper:px-8 paper:py-10 paper:space-y-5">
        {messages.length === 0 && !executing && (
          // Empty-state rendering no longer depends on the historical
          // `pre-game` / `character_creation` / `playing` enum. After the
          // turn-band migration the session is fully described by
          // `status + turnCount + preGameCompleted`; here we only need the
          // derived `LegacyPhase` (`init` / `playing` / `paused` / `ended`)
          // to choose between the "begin adventure" CTA and the post-start
          // empty message.
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-6 paper:py-24">
            {phase === "init" ? (
              <>
                <div className="space-y-2 paper:space-y-3">
                  <p className="text-base font-semibold paper:font-serif paper:italic paper:font-normal paper:text-2xl paper:text-foreground">
                    {world ? (typeof world.name === "string" ? world.name : (world.name as Record<string, string>)["zh-CN"] ?? "") : ""}
                  </p>
                  <p className="text-sm text-muted-foreground max-w-xs paper:font-serif paper:max-w-md paper:leading-relaxed">
                    {t("session.beginAdventureHint")}
                  </p>
                </div>
                <Button
                  size="lg"
                  className="px-10 py-5 text-sm uppercase tracking-widest font-bold paper:rounded-md paper:bg-[color:var(--color-primary)] paper:text-[color:var(--color-primary-foreground)] paper:font-sans paper:font-medium paper:tracking-[0.1em]"
                  onClick={onBeginAdventure}
                >
                  <Flame className="w-4 h-4 mr-2" />
                  {t("session.beginAdventure")}
                </Button>
              </>
            ) : (
              <>
                <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
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
  const turnId = ((block.meta as Record<string, unknown> | undefined)?.turnId as string | undefined) ?? "";

  const handlers = useMemo(() => ({
    draftMessage: async (params: Record<string, unknown>) => {
      if (locked) return;
      const text = String(params.text ?? "").trim();
      if (!text) return;
      const selectionGroup = typeof params.selectionGroup === "string" ? params.selectionGroup : undefined;
      upsertInteractionDraft({
        id: selectionGroup ? `${turnId || "plugin"}:${selectionGroup}` : `plugin-draft:${text}`,
        turnId: turnId || "plugin",
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
  }), [locked, turnId, sendMessage, upsertInteractionDraft, setComposerText]);

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
      ((data.interactionId as string | undefined) ?? (data.formId as string | undefined) ?? "form");
    const turnId = ((meta.turnId as string | undefined) ?? msg.turnId ?? "");
    const rawBehavior = data.submitBehavior as Record<string, unknown> | undefined;
    const submitBehavior = rawBehavior
      ? {
          echoFilledNarrative: rawBehavior.echoFilledNarrative as boolean | undefined,
        }
      : undefined;
    return { data, turnId, interactionId, submitBehavior };
  }, [block, msg.turnId]);

  const handlers = useMemo(() => ({
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

      const fields = (data.fields as Array<{ name?: string; required?: boolean }> | undefined) ?? [];
      const missingRequired = fields.some((field) => {
        if (!field?.required || !field.name) return false;
        return !(formValues[field.name]?.trim());
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
      const selectionGroup = typeof params.selectionGroup === "string" ? params.selectionGroup : undefined;
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
  }), [effectiveSubmitted, readBlockMeta, msg.id, msg.turnId, onSubmitInteraction, onSendMessage, onSubmitBlock, upsertInteractionDraft]);

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
          effectiveSubmitted && submittedValues
            ? { form: submittedValues }
            : {}
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
function hasLaterUserMessage(msg: StreamMessage, all: StreamMessage[]): boolean {
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
      <span className="font-semibold not-italic">{t("interaction.playerSelected")}</span>
      <span className="whitespace-pre-wrap break-words">{label}</span>
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
