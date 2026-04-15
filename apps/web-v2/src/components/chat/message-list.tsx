/**
 * MessageList — renders all game messages via json-render.
 *
 * Every message type (narrative, player input, forms, notifications)
 * is converted to a json-render spec and rendered through the unified
 * component catalog. No hardcoded React rendering.
 */

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
import { PluginPanel } from "@/components/panels/plugin-panel.js";
import type { GameMessage } from "@/stores/session-store.js";
import { sendMessage, setComposerText, submitFormInputs, upsertPendingInteractionDraft } from "@/stores/session-store.js";

interface MessageListProps {
  messages: GameMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const visible = messages.filter((m) => m.content || m.block);

  return (
    <div className="space-y-4 pb-4">
      {visible.map((msg, index) => (
        <MessageRenderer
          key={msg.id}
          message={msg}
          hasLaterUserMessage={visible.slice(index + 1).some((item) => item.role === "user")}
          hasLaterStoryMessage={visible.slice(index + 1).some((item) => item.role === "assistant" && item.kind === "story")}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageRenderer({
  message,
  hasLaterUserMessage,
  hasLaterStoryMessage,
}: {
  message: GameMessage;
  hasLaterUserMessage: boolean;
  hasLaterStoryMessage: boolean;
}) {
  const [submitted, setSubmitted] = useState(false);
  const formStateRef = useRef<Record<string, unknown>>({});

  const hasInteraction = Boolean(message.block);
  const submittedFromHistory = hasLaterUserMessage && isFormLikeBlock(message.block);
  const effectiveSubmitted = submitted || submittedFromHistory;
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

        setSubmitted(true);
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
      } else {
        setSubmitted(true);
        // Fallback: just send form values as message
        const parts = Object.entries(formValues)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => `${k}: ${v}`);
        setComposerText(parts.join(", ") || "(表单已提交)");
      }
    },
    selectChoice: async (params: Record<string, unknown>) => {
      if (effectiveSubmitted) return;
      setSubmitted(true);
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

  return (
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{}}
      handlers={handlers}
      onStateChange={handleStateChange}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
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
