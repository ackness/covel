/**
 * Framework default `submit-form` RPC handler.
 *
 * Persists player inputs and fills the originating interaction template.
 * This framework default is registered as `plugin-rpc` action
 * `{ pluginId: "framework", action: "submit-form" }`.
 */

import {
  DEFAULT_LOCALE,
  resolveI18nText,
  type I18nText,
  type InteractionType,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import type { RpcHandler, RpcHandlerContext } from "../rpc/rpc-registry.js";

interface Submission {
  readonly interactionId: string;
  // Single source of truth: InteractionType (packages/shared execution.ts).
  readonly type: InteractionType;
  readonly values: Record<string, unknown>;
}

interface SubmitFormPayload {
  readonly turnId: string;
  readonly submissions?: unknown;
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
  readonly sourceType: string;
  readonly role: string;
  readonly pendingInput?: unknown;
  readonly content: string;
  readonly name?: string;
  readonly order: number;
}

interface LocatedInteraction {
  readonly message: MessageLike;
  readonly interaction: Record<string, unknown> & {
    readonly interactionId: string;
    readonly type: InteractionType;
  };
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
 * locale. A missing locale keeps the historical zh-CN default; an unsupported
 * locale follows the shared English fallback contract.
 */
interface SubmitFormLabels {
  readonly confirm: string;
  readonly cancel: string;
  readonly formPrefix: string;
  readonly choicePrefix: string;
  readonly confirmedPrefix: string;
  readonly cancelledPrefix: string;
}

const SUBMIT_FORM_LABELS = {
  confirm: { "zh-CN": "确认", "en-US": "Confirm", "ru-RU": "Подтвердить" },
  cancel: { "zh-CN": "取消", "en-US": "Cancel", "ru-RU": "Отмена" },
  formPrefix: {
    "zh-CN": "[玩家输入]",
    "en-US": "[Player input]",
    "ru-RU": "[Ввод игрока]",
  },
  choicePrefix: {
    "zh-CN": "[玩家选择]",
    "en-US": "[Player choice]",
    "ru-RU": "[Выбор игрока]",
  },
  confirmedPrefix: {
    "zh-CN": "[玩家确认]",
    "en-US": "[Player confirmed]",
    "ru-RU": "[Игрок подтвердил]",
  },
  cancelledPrefix: {
    "zh-CN": "[玩家取消]",
    "en-US": "[Player cancelled]",
    "ru-RU": "[Игрок отменил]",
  },
} as const satisfies Record<keyof SubmitFormLabels, I18nText>;

function resolveLabel(value: I18nText, locale: string): string {
  return resolveI18nText(value, locale) ?? "";
}

/** Resolve labels through the shared locale fallback chain. */
function resolveLabels(locale?: string): SubmitFormLabels {
  const effectiveLocale = locale ?? DEFAULT_LOCALE;
  return {
    confirm: resolveLabel(SUBMIT_FORM_LABELS.confirm, effectiveLocale),
    cancel: resolveLabel(SUBMIT_FORM_LABELS.cancel, effectiveLocale),
    formPrefix: resolveLabel(SUBMIT_FORM_LABELS.formPrefix, effectiveLocale),
    choicePrefix: resolveLabel(
      SUBMIT_FORM_LABELS.choicePrefix,
      effectiveLocale,
    ),
    confirmedPrefix: resolveLabel(
      SUBMIT_FORM_LABELS.confirmedPrefix,
      effectiveLocale,
    ),
    cancelledPrefix: resolveLabel(
      SUBMIT_FORM_LABELS.cancelledPrefix,
      effectiveLocale,
    ),
  };
}

function findCommittedInteraction(
  messages: readonly MessageLike[],
  turnId: string,
  interactionId: string,
): LocatedInteraction | undefined {
  for (const m of messages) {
    if (
      m.turnId !== turnId ||
      m.sourceType !== "runtime" ||
      m.role !== "assistant" ||
      !m.pendingInput
    ) {
      continue;
    }
    const pi = m.pendingInput;
    if (Array.isArray(pi)) {
      const interaction = pi.find(
        (candidate): candidate is Record<string, unknown> =>
          !!candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          candidate.interactionId === interactionId,
      );
      if (interaction && VALID_TYPES.has(interaction.type as InteractionType)) {
        return {
          message: m,
          interaction: interaction as LocatedInteraction["interaction"],
        };
      }
    }
  }
  return undefined;
}

function assertOnlyKeys(
  values: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  interactionId: string,
): void {
  const unknown = Object.keys(values).find((key) => !allowed.has(key));
  if (unknown) {
    throw new RpcValidationError(
      `Unknown field "${unknown}" for interactionId: ${interactionId}`,
    );
  }
}

function isMissingRequired(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

function optionValue(option: unknown): string | undefined {
  if (typeof option === "string") return option;
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return undefined;
  }
  const value = (option as Record<string, unknown>).value;
  return typeof value === "string" ? value : undefined;
}

function validateFormValues(
  interaction: LocatedInteraction["interaction"],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!Array.isArray(interaction.fields)) {
    throw new RpcValidationError(
      `Committed form ${interaction.interactionId} is missing fields`,
    );
  }

  const fields = interaction.fields as Array<Record<string, unknown>>;
  const declared = new Map<string, Record<string, unknown>>();
  for (const field of fields) {
    const name =
      typeof field.name === "string"
        ? field.name
        : typeof field.id === "string"
          ? field.id
          : "";
    if (!name) {
      throw new RpcValidationError(
        `Committed form ${interaction.interactionId} contains a field without a name`,
      );
    }
    declared.set(name, field);
  }
  assertOnlyKeys(values, new Set(declared.keys()), interaction.interactionId);

  const normalizedValues: Record<string, unknown> = { ...values };
  for (const [name, field] of declared) {
    const submitted = values[name];
    const value =
      isMissingRequired(submitted) && typeof field.defaultValue === "string"
        ? field.defaultValue
        : submitted;
    if (value !== undefined) normalizedValues[name] = value;
    if (field.required === true && isMissingRequired(value)) {
      throw new RpcValidationError(
        `Required field "${name}" is missing for interactionId: ${interaction.interactionId}`,
      );
    }
    if (value === undefined || value === null) continue;

    switch (field.type) {
      case "text":
      case "textarea":
        if (typeof value !== "string") {
          throw new RpcValidationError(`Field "${name}" must be a string`);
        }
        break;
      case "number":
        if (!(
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" &&
            value.trim().length > 0 &&
            Number.isFinite(Number(value)))
        )) {
          throw new RpcValidationError(`Field "${name}" must be a number`);
        }
        break;
      case "checkbox":
        if (
          typeof value !== "boolean" &&
          value !== "true" &&
          value !== "false"
        ) {
          throw new RpcValidationError(`Field "${name}" must be a checkbox`);
        }
        break;
      case "select": {
        if (typeof value !== "string") {
          throw new RpcValidationError(`Field "${name}" must be a string`);
        }
        const allowed = Array.isArray(field.options)
          ? field.options.map(optionValue).filter((item) => item !== undefined)
          : [];
        if (!allowed.includes(value)) {
          throw new RpcValidationError(
            `Field "${name}" must match a declared option`,
          );
        }
        break;
      }
      default:
        throw new RpcValidationError(
          `Committed form ${interaction.interactionId} has unsupported field type: ${String(field.type)}`,
        );
    }
  }
  return normalizedValues;
}

function validateSubmissionValues(
  sub: Submission,
  interaction: LocatedInteraction["interaction"],
): Record<string, unknown> {
  if (sub.type !== interaction.type) {
    throw new RpcValidationError(
      `Submission type must match committed interaction type "${interaction.type}" for interactionId: ${sub.interactionId}`,
    );
  }

  switch (interaction.type) {
    case "form":
      return validateFormValues(interaction, sub.values);
    case "choice": {
      assertOnlyKeys(
        sub.values,
        new Set(["selectedId", "selectedLabel"]),
        sub.interactionId,
      );
      const selectedId = sub.values.selectedId;
      if (typeof selectedId !== "string" || !selectedId) {
        throw new RpcValidationError(
          `selectedId (string) is required for interactionId: ${sub.interactionId}`,
        );
      }
      const choices = Array.isArray(interaction.choices)
        ? (interaction.choices as Array<Record<string, unknown>>)
        : [];
      const selected = choices.find((choice) => choice.id === selectedId);
      if (!selected || typeof selected.label !== "string") {
        throw new RpcValidationError(
          `selectedId must match a declared choice for interactionId: ${sub.interactionId}`,
        );
      }
      return { selectedId, selectedLabel: selected.label };
    }
    case "confirmation":
      assertOnlyKeys(sub.values, new Set(["confirmed"]), sub.interactionId);
      if (typeof sub.values.confirmed !== "boolean") {
        throw new RpcValidationError(
          `confirmed (boolean) is required for interactionId: ${sub.interactionId}`,
        );
      }
      return { confirmed: sub.values.confirmed };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

function fallbackNarrative(
  sub: Submission,
  labels: SubmitFormLabels,
  interaction?: Readonly<Record<string, unknown>>,
): string {
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
      return `${sub.values.confirmed ? labels.confirmedPrefix : labels.cancelledPrefix} ${String(interaction?.prompt ?? "")}`;
  }
}

function fillTemplate(
  sub: Submission,
  located: LocatedInteraction,
  labels: SubmitFormLabels,
): string {
  let template = located.message.content;
  if (typeof located.interaction.narrativeTemplate === "string") {
    template = located.interaction.narrativeTemplate;
  }
  if (!template) return fallbackNarrative(sub, labels, located.interaction);

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

  if (!Array.isArray(body.submissions) || body.submissions.length === 0) {
    throw new RpcValidationError("submissions[] is required");
  }

  const submissions: Submission[] = [];
  for (const rawSubmission of body.submissions) {
    if (
      !rawSubmission ||
      typeof rawSubmission !== "object" ||
      Array.isArray(rawSubmission)
    ) {
      throw new RpcValidationError("Each submission must be an object");
    }
    const sub = rawSubmission as Submission;
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
    submissions.push(sub);
  }

  // Framework defaults run with the trusted store view, whose runtime surface
  // is the full DataStore. Keep the public RpcHandlerStore contract narrow for
  // third-party handlers and narrow this cast to the two framework-only reads /
  // transaction methods used here.
  const frameworkStore = store as typeof store &
    Pick<DataStore, "listPlayerInputs" | "withTransaction">;
  const messages = (await frameworkStore.listTurnMessages(
    sessionId,
  )) as readonly MessageLike[];
  const existingInputs = await frameworkStore.listPlayerInputs(sessionId);
  const prepared: Array<{
    readonly submissionId: string;
    readonly interactionId: string;
    readonly values: Record<string, unknown>;
    readonly filledNarrative: string;
    readonly shouldPersist: boolean;
  }> = [];
  const preparedByKey = new Map<string, (typeof prepared)[number]>();

  for (const sub of submissions) {
    const located = findCommittedInteraction(
      messages,
      body.turnId,
      sub.interactionId,
    );
    if (!located) {
      throw new RpcValidationError(
        `No committed interaction found for turnId=${body.turnId}, interactionId=${sub.interactionId}`,
      );
    }
    const values = validateSubmissionValues(sub, located.interaction);
    const normalizedSub: Submission = { ...sub, values };
    const key = `${body.turnId}\0${sub.interactionId}`;
    const duplicateInBatch = preparedByKey.get(key);
    if (duplicateInBatch) {
      if (stableJson(duplicateInBatch.values) !== stableJson(values)) {
        throw new RpcValidationError(
          `Interaction ${sub.interactionId} is submitted more than once with conflicting values`,
        );
      }
      prepared.push({ ...duplicateInBatch, shouldPersist: false });
      continue;
    }

    const existing = existingInputs.find(
      (input) =>
        input.turnId === body.turnId && input.formId === sub.interactionId,
    );
    if (existing && stableJson(existing.values) !== stableJson(values)) {
      throw new RpcValidationError(
        `Interaction ${sub.interactionId} was already submitted with different values`,
      );
    }
    const item = {
      submissionId: existing?.id ?? crypto.randomUUID(),
      interactionId: sub.interactionId,
      values,
      filledNarrative: fillTemplate(normalizedSub, located, labels),
      shouldPersist: !existing,
    };
    prepared.push(item);
    preparedByKey.set(key, item);
  }

  const writes = prepared.filter((item) => item.shouldPersist);
  const persist = async (target: Pick<DataStore, "savePlayerInput">) => {
    const createdAt = new Date().toISOString();
    for (const item of writes) {
      await target.savePlayerInput({
        id: item.submissionId,
        sessionId,
        turnId: body.turnId,
        formId: item.interactionId,
        values: item.values,
        createdAt,
      });
    }
  };
  if (writes.length > 0) {
    await frameworkStore.withTransaction(async (tx) => persist(tx));
  }

  return {
    accepted: true,
    results: prepared.map((item) => ({
      submissionId: item.submissionId,
      interactionId: item.interactionId,
      filledNarrative: item.filledNarrative,
      accepted: true,
    })),
  };
};
