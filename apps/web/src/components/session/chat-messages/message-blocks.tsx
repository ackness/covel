import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { emitToast } from "@/lib/toast-channel.js";
import { nestedToFlat } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { useSessionActions } from "@/stores/session-store.js";
import { PluginPanel } from "../plugin-panel.js";
import { RawJsonBlock } from "./message-primitives.js";

// When the server synthesizes a `plugin_message` block from plugin-data on
// namespace="message", we get:
//   block.data.pluginId  — which plugin authored the surface
//   block.data.specs     — json-render specs from the plugin manifest (ui.message[])
//   block.data.state     — current plugin-data snapshot (stripped of __private keys)
//
// Each spec is rendered by PluginPanel, which reads the live plugin-data
// store (so subsequent changes trigger reactive re-renders without waiting
// for another synthesized block).
export function PluginMessageBlock({
  block,
  sourceBlockId,
  locked,
}: {
  block: Record<string, unknown>;
  /** StreamMessage id of the surrounding block, used to attribute drafts back to their source. */
  sourceBlockId: string;
  locked: boolean;
}) {
  const { sendMessage, upsertInteractionDraft, setComposerText } =
    useSessionActions();
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
    [
      locked,
      turnId,
      sourceBlockId,
      sendMessage,
      upsertInteractionDraft,
      setComposerText,
    ],
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

export function UiRenderBlock({ block }: { block: Record<string, unknown> }) {
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

export function BranchReplyBlock({
  block,
}: {
  block: Record<string, unknown>;
}) {
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

// Renders any block other than plugin_message using message-to-spec +
// json-render. Form/choice handlers bridge into onSubmitInteraction so
// the framework submit-form RPC + echoFilledNarrative UX hint keeps
// working exactly as before.
export function MessageBlockRenderer({
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
  const { t } = useTranslation();
  const { upsertInteractionDraft } = useSessionActions();
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
            | Array<{ name?: string; label?: string; required?: boolean }>
            | undefined) ?? [];
        const missingFields = fields.filter((field) => {
          if (!field?.required || !field.name) return false;
          return !formValues[field.name]?.trim();
        });
        if (missingFields.length > 0) {
          const names = missingFields
            .map((field) => field.label ?? field.name)
            .join("、");
          emitToast(
            "error",
            t("form.requiredMissing", "Please fill in required fields"),
            names,
          );
          return;
        }

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
          // Fallback: submit-form unavailable -> stringified payload
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
      t,
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
          {t("session.blockLabel", "Block")}: {block.type as string}
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
// disabled state — mirrors the `hasLaterUserMessage` / messageToSpecDisabled
// coupling.
export function hasLaterUserMessage(
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
