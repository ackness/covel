/**
 * MessageList — renders all game messages via json-render.
 *
 * Every message type (narrative, player input, forms, notifications)
 * is converted to a json-render spec and rendered through the unified
 * component catalog. No hardcoded React rendering.
 */

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { Copy, Check, RotateCcw } from "lucide-react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
import { PluginPanel } from "@/components/panels/plugin-panel.js";
import type { GameMessage } from "@/stores/session-store.js";
import {
  sendMessage,
  setComposerText,
  submitFormInputs,
  upsertPendingInteractionDraft,
  retryRuntime,
} from "@/stores/session-store.js";

interface MessageListProps {
  messages: GameMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const visible = messages.filter((m) => m.content || m.block);

  // Identify the turnId of the most recent turn so we only show Retry
  // on messages belonging to that turn — retrying an earlier turn would
  // produce divergent narrative and is disabled.
  const latestTurnId = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      if (visible[i].turnId) return visible[i].turnId;
    }
    return undefined;
  }, [visible]);

  return (
    <div className="space-y-4 pb-4">
      {visible.map((msg, index) => (
        <MessageRenderer
          key={msg.id}
          message={msg}
          hasLaterUserMessage={visible.slice(index + 1).some((item) => item.role === "user")}
          hasLaterStoryMessage={visible.slice(index + 1).some((item) => item.role === "assistant" && item.kind === "story")}
          isLatestTurn={msg.turnId !== undefined && msg.turnId === latestTurnId}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ── Message action overlay ──────────────────────────────────────

/**
 * Floating action bar shown on hover over assistant narrative messages.
 *
 * - `Copy`: writes `message.content` to the clipboard.
 * - `Retry`: re-runs the runtime that produced this message. Only
 *   visible on messages from the most recent turn — retrying an earlier
 *   turn would branch the timeline and is not supported.
 */
function MessageActionBar({
  message,
  showRetry,
}: {
  message: GameMessage;
  showRetry: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = message.content ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked by browser permissions — swallow.
    }
  }, [message.content]);

  const handleRetry = useCallback(() => {
    void retryRuntime(message.runtimeId);
  }, [message.runtimeId]);

  return (
    <div
      className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      aria-label="message actions"
    >
      <button
        type="button"
        onClick={handleCopy}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300/80 bg-white/90 text-zinc-500 shadow-sm transition-colors hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/85 dark:text-zinc-400 dark:hover:text-zinc-100"
        title={copied ? "已复制" : "复制内容"}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {showRetry && (
        <button
          type="button"
          onClick={handleRetry}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300/80 bg-white/90 text-zinc-500 shadow-sm transition-colors hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/85 dark:text-zinc-400 dark:hover:text-zinc-100"
          title="重新生成这一轮"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function MessageRenderer({
  message,
  hasLaterUserMessage,
  hasLaterStoryMessage,
  isLatestTurn,
}: {
  message: GameMessage;
  hasLaterUserMessage: boolean;
  hasLaterStoryMessage: boolean;
  isLatestTurn: boolean;
}) {
  const formStateRef = useRef<Record<string, unknown>>({});

  const hasInteraction = Boolean(message.block);
  const submittedFromHistory = hasLaterUserMessage && isFormLikeBlock(message.block);
  const effectiveSubmitted = submittedFromHistory;
  const collapseResolvedInteraction =
    hasInteraction &&
    hasLaterStoryMessage &&
    shouldCollapseAfterStory(message.block);

  const spec = useMemo(() => {
    if (isPluginMessageBlock(message.block)) return null;
    if (collapseResolvedInteraction) return null;
    const nested = effectiveSubmitted && hasInteraction
      ? messageToSpecDisabled(message)
      : messageToSpec(message);
    if (!nested) return null;
    try {
      return nestedToFlat(nested);
    } catch {
      return null;
    }
  }, [message, effectiveSubmitted, hasInteraction, collapseResolvedInteraction]);

  const handleStateChange = useCallback((changes: Array<{ path: string; value: unknown }>) => {
    for (const { path, value } of changes) {
      formStateRef.current[path] = value;
    }
  }, []);

  const handlers = useMemo(() => ({
    submitForm: async () => {
      if (effectiveSubmitted) return;

      // Extract form field values from tracked json-render state
      const formValues: Record<string, string> = {};
      for (const [path, value] of Object.entries(formStateRef.current)) {
        const match = path.match(/^\/form\/(.+)$/);
        if (match && value) {
          formValues[match[1]] = String(value);
        }
      }

      // Get block metadata for submit-inputs API
      const block = message.block;
      if (block) {
        const data = (block.data ?? block) as Record<string, unknown>;
        const fields = (data.fields as Array<{ name?: string; required?: boolean }> | undefined) ?? [];
        const missingRequired = fields.some((field) => {
          if (!field?.required || !field.name) return false;
          return !(formValues[field.name]?.trim());
        });
        if (missingRequired) return;

        const interactionId = (data.interactionId ?? data.formId ?? "form") as string;
        const turnId = ((block.meta as Record<string, unknown>)?.turnId ?? message.turnId ?? "") as string;
        const submitBehavior = data.submitBehavior as Record<string, unknown> | undefined;

        // Submit raw form values. Character creation is now owned by the
        // plugin's player-init runtime, which reads the submission from context
        // via {{ player.lastFormValues }} and calls create-character.
        await submitFormInputs({
          turnId,
          interactionId,
          values: formValues,
          label: (data.title as string | undefined) ?? interactionId,
          submitBehavior: submitBehavior
            ? {
              echoFilledNarrative: submitBehavior.echoFilledNarrative as boolean | undefined,
              autoContinue: submitBehavior.autoContinue as boolean | undefined,
            }
            : undefined,
        });

        // Plugin-declared UX hint: if the interaction is marked `immediate`,
        // submitting advances the turn right away instead of parking the draft
        // in the input bar for "unified send". This is a plugin-opt-in field
        // on block.data.submitBehavior — the framework stays neutral and only
        // honours what the plugin declared.
        if (submitBehavior?.immediate === true) {
          await sendMessage();
        }
      } else {
        // Fallback: just send form values as message
        const parts = Object.entries(formValues)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => `${k}: ${v}`);
        setComposerText(parts.join(", ") || "(表单已提交)");
      }
    },
    selectChoice: async (params: Record<string, unknown>) => {
      if (effectiveSubmitted) return;
      const block = message.block;
      const label = params.label as string;
      if (!block || !label) return;
      const data = (block.data ?? block) as Record<string, unknown>;
      const interactionId = (data.interactionId ?? data.formId ?? "choice") as string;
      const turnId = ((block.meta as Record<string, unknown>)?.turnId ?? message.turnId ?? "") as string;
      const submitBehavior = data.submitBehavior as Record<string, unknown> | undefined;
      upsertPendingInteractionDraft({
        id: `${turnId}:${interactionId}`,
        turnId,
        interactionId,
        type: "choice",
        label,
        values: {
          selectedId: params.choiceId,
          selectedLabel: label,
        },
        submitBehavior: submitBehavior
          ? {
            echoFilledNarrative: submitBehavior.echoFilledNarrative as boolean | undefined,
            autoContinue: submitBehavior.autoContinue as boolean | undefined,
          }
          : undefined,
      });
    },
    selectSuggestion: async (params: Record<string, unknown>) => {
      const text = params.text as string;
      if (!text) return;
      const selectionGroup = typeof params.selectionGroup === "string" ? params.selectionGroup : undefined;
      upsertPendingInteractionDraft({
        id: selectionGroup
          ? `${message.turnId ?? "suggestion"}:${selectionGroup}`
          : `suggestion:${text}`,
        turnId: message.turnId ?? "suggestion",
        interactionId: selectionGroup ?? `suggestion:${text}`,
        type: "suggestion",
        label: text,
        values: { text },
        selectionGroup,
      });
    },
    sendCustomAction: async (params: Record<string, unknown>) => {
      const text = String(params.text ?? "").trim();
      if (!text) return;
      await sendMessage(text);
    },
  }), [effectiveSubmitted, message]);

  if (isPluginMessageBlock(message.block)) {
    const pluginBlock = message.block;
    const data = (pluginBlock.data ?? pluginBlock) as Record<string, unknown>;
    const pluginId = data.pluginId as string;
    const specs = (data.specs ?? []) as Array<Record<string, unknown>>;
    const state = (data.state ?? {}) as Record<string, unknown>;
    const locked = hasLaterUserMessage;

    return (
      <div className="space-y-4">
        {specs.map((pluginSpec, index) => (
          <PluginPanel
            key={`${message.id}:${index}`}
            pluginId={pluginId}
            spec={pluginSpec}
            stateOverride={state}
            interactionLocked={locked}
            handlers={{
              draftMessage: async (params: Record<string, unknown>) => {
                if (locked) return;
                const text = String(params.text ?? "").trim();
                if (!text) return;
                const selectionGroup = typeof params.selectionGroup === "string" ? params.selectionGroup : undefined;
                upsertPendingInteractionDraft({
                  id: selectionGroup
                    ? `${message.turnId ?? "plugin"}:${selectionGroup}`
                    : `plugin-draft:${text}`,
                  turnId: message.turnId ?? "plugin",
                  interactionId: selectionGroup ?? `plugin-draft:${text}`,
                  type: "suggestion",
                  label: text,
                  values: { text },
                  selectionGroup,
                });
              },
              sendMessage: async (params: Record<string, unknown>) => {
                if (locked) return;
                const text = String(params.text ?? "").trim();
                if (!text) return;
                await sendMessage(text);
              },
              setComposerText: async (params: Record<string, unknown>) => {
                if (locked) return;
                setComposerText(String(params.text ?? ""));
              },
            }}
          />
        ))}
      </div>
    );
  }

  if (!spec) return null;

  // Decorate assistant narrative messages with a hover action bar.
  // Skip user / system / interactive blocks — those have their own
  // affordances (or nothing to copy / retry).
  const showActionBar =
    message.role === "assistant" &&
    !hasInteraction &&
    !effectiveSubmitted &&
    Boolean(message.content);

  const content = (
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{}}
      handlers={handlers}
      onStateChange={handleStateChange}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
  );

  if (!showActionBar) return content;

  return (
    <div className="group relative">
      {content}
      <MessageActionBar message={message} showRetry={isLatestTurn} />
    </div>
  );
}

function isPluginMessageBlock(block: GameMessage["block"]): block is Record<string, unknown> {
  if (!block) return false;
  return block.type === "plugin_message";
}

function isFormLikeBlock(block: GameMessage["block"]): boolean {
  if (!block) return false;
  const data = (block.data ?? block) as Record<string, unknown>;
  const type = block.type as string | undefined;
  const innerType = data.type as string | undefined;
  return innerType === "form" || type === "interactive_form" || Array.isArray(data.fields);
}

function shouldCollapseAfterStory(block: GameMessage["block"]): boolean {
  if (!block) return false;
  const data = (block.data ?? block) as Record<string, unknown>;
  const submitBehavior = data.submitBehavior as Record<string, unknown> | undefined;
  return submitBehavior?.autoContinue === true;
}
