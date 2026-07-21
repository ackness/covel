/**
 * Framework default `submit-form` RPC handler.
 *
 * Persists player inputs and fills the originating interaction template.
 * This framework default is registered as `plugin-rpc` action
 * `{ pluginId: "framework", action: "submit-form" }`.
 */

import type { InteractionType } from "@covel/shared";
import type { RpcHandler, RpcHandlerContext } from "../rpc/rpc-registry.js";

interface Submission {
  readonly interactionId: string;
  // Single source of truth: InteractionType (packages/shared execution.ts).
  readonly type: InteractionType;
  readonly values: Record<string, unknown>;
}

interface SubmitFormPayload {
  readonly turnId: string;
  readonly submissions?: readonly Submission[];
}

interface SubmitFormResult {
  readonly accepted: boolean;
  readonly results: ReadonlyArray<{
    readonly submissionId: string;
    readonly interactionId: string;
    readonly filledNarrative: string;
    readonly accepted: boolean;
  }>;
}

interface MessageLike {
  readonly turnId: string;
  readonly pendingInput?: unknown;
  readonly content: string;
  readonly name?: string;
  readonly order: number;
}

// Exported for the alignment test that pins this Set against InteractionType.
export const VALID_TYPES = new Set<InteractionType>([
  "form",
  "choice",
  "confirmation",
]);

/**
 * Localized labels for player-input narrative filling. The confirmation values
 * and fallback prefixes were previously hardcoded Chinese; they now resolve by
 * locale. Unknown / missing locale falls back to zh-CN so existing zh-CN output
 * stays byte-for-byte identical.
 */
interface SubmitFormLabels {
  readonly confirm: string;
  readonly cancel: string;
  readonly formPrefix: string;
  readonly choicePrefix: string;
  readonly confirmedPrefix: string;
  readonly cancelledPrefix: string;
}

const SUBMIT_FORM_LABELS: Record<string, SubmitFormLabels> = {
  "zh-CN": {
    confirm: "确认",
    cancel: "取消",
    formPrefix: "[玩家输入]",
    choicePrefix: "[玩家选择]",
    confirmedPrefix: "[玩家确认]",
    cancelledPrefix: "[玩家取消]",
  },
  "en-US": {
    confirm: "Confirm",
    cancel: "Cancel",
    formPrefix: "[Player input]",
    choicePrefix: "[Player choice]",
    confirmedPrefix: "[Player confirmed]",
    cancelledPrefix: "[Player cancelled]",
  },
};

/** Resolve labels for a locale, falling back to zh-CN (byte-compatible default). */
function resolveLabels(locale?: string): SubmitFormLabels {
  // `??` (nullish) not `||`: only an absent/unknown locale falls back, and the
  // locale guard avoids indexing the record with `undefined`.
  return (
    (locale ? SUBMIT_FORM_LABELS[locale] : undefined) ??
    SUBMIT_FORM_LABELS["zh-CN"]!
  );
}

function findTemplateMessage(
  messages: readonly MessageLike[],
  turnId: string,
  interactionId: string,
): MessageLike | undefined {
  return messages.find((m) => {
    if (m.turnId !== turnId || !m.pendingInput) return false;
    const pi = m.pendingInput;
    if (Array.isArray(pi)) {
      return (pi as Array<Record<string, unknown>>).some(
        (i) => i.interactionId === interactionId,
      );
    }
    return (pi as Record<string, unknown>).formId === interactionId;
  });
}

function buildReplacements(
  sub: Submission,
  labels: SubmitFormLabels,
): Record<string, unknown> {
  switch (sub.type) {
    case "form":
      return sub.values;
    case "choice":
      return {
        ...sub.values,
        selectedId: sub.values.selectedId,
        selectedLabel: sub.values.selectedLabel ?? sub.values.selectedId,
      };
    case "confirmation":
      return {
        ...sub.values,
        confirmed: sub.values.confirmed ? labels.confirm : labels.cancel,
      };
  }
}

function fallbackNarrative(sub: Submission, labels: SubmitFormLabels): string {
  switch (sub.type) {
    case "form": {
      const entries = Object.entries(sub.values)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      return `${labels.formPrefix} ${entries}`;
    }
    case "choice":
      return `${labels.choicePrefix} ${String(sub.values.selectedLabel ?? sub.values.selectedId)}`;
    case "confirmation":
      return `${sub.values.confirmed ? labels.confirmedPrefix : labels.cancelledPrefix} ${String(sub.values.prompt ?? "")}`;
  }
}

function fillTemplate(
  sub: Submission,
  templateMessage: MessageLike | undefined,
  labels: SubmitFormLabels,
): string {
  if (!templateMessage) return fallbackNarrative(sub, labels);

  let template = templateMessage.content;
  if (Array.isArray(templateMessage.pendingInput)) {
    const interaction = (
      templateMessage.pendingInput as Array<Record<string, unknown>>
    ).find((i) => i.interactionId === sub.interactionId);
    if (
      interaction?.narrativeTemplate &&
      typeof interaction.narrativeTemplate === "string"
    ) {
      template = interaction.narrativeTemplate;
    }
  }

  const replacements = buildReplacements(sub, labels);
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
    const value = replacements[key.trim()];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

export class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

export const submitFormHandler: RpcHandler = async (
  payload: unknown,
  context: RpcHandlerContext,
): Promise<SubmitFormResult> => {
  const { sessionId, store, locale } = context;
  const labels = resolveLabels(locale);

  if (!payload || typeof payload !== "object") {
    throw new RpcValidationError("payload must be an object");
  }
  const body = payload as SubmitFormPayload;

  if (!body.turnId || typeof body.turnId !== "string") {
    throw new RpcValidationError("turnId (string) is required");
  }

  const submissions: Submission[] = body.submissions
    ? [...body.submissions]
    : [];

  if (submissions.length === 0) {
    throw new RpcValidationError("submissions[] is required");
  }

  for (const sub of submissions) {
    if (!sub.interactionId || typeof sub.interactionId !== "string") {
      throw new RpcValidationError(
        "Each submission requires interactionId (string)",
      );
    }
    if (!VALID_TYPES.has(sub.type)) {
      throw new RpcValidationError(
        `Invalid submission type: ${sub.type}. Must be form|choice|confirmation`,
      );
    }
    if (
      !sub.values ||
      typeof sub.values !== "object" ||
      Array.isArray(sub.values)
    ) {
      throw new RpcValidationError(
        `submission.values must be an object for interactionId: ${sub.interactionId}`,
      );
    }
  }

  const messages = (await store.listTurnMessages(
    sessionId,
  )) as readonly MessageLike[];
  const out: Array<SubmitFormResult["results"][number]> = [];

  for (const sub of submissions) {
    const submissionId = crypto.randomUUID();
    await store.savePlayerInput({
      id: submissionId,
      sessionId,
      turnId: body.turnId,
      formId: sub.interactionId,
      values: sub.values,
      createdAt: new Date().toISOString(),
    });

    const templateMessage = findTemplateMessage(
      messages,
      body.turnId,
      sub.interactionId,
    );
    const filledNarrative = fillTemplate(sub, templateMessage, labels);

    out.push({
      submissionId,
      interactionId: sub.interactionId,
      filledNarrative,
      accepted: true,
    });
  }

  return { accepted: true, results: out };
};
