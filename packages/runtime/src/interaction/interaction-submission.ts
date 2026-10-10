/**
 * A player's answer to a committed form, choice or confirmation.
 *
 * The submitter validates the answer against the committed interaction and
 * fills its narrative template. It writes nothing: the caller stores the
 * answer with `persist` in the transaction that starts the follow-up turn, so
 * an interaction is answered once and its turn runs once.
 */

import {
  DEFAULT_LOCALE,
  MAX_PLAYER_MESSAGE_CHARS,
  resolveI18nText,
  type I18nText,
  type InteractionType,
} from "@covel/shared";
import type { FormIssue, ValidatePluginForm } from "../rpc/form-validator.js";
import type { DataStore } from "@covel/store";

interface Submission {
  readonly interactionId: string;
  // Single source of truth: InteractionType (packages/shared execution.ts).
  readonly type: InteractionType;
  readonly values: Record<string, unknown>;
}

interface SubmissionPayload {
  readonly turnId: string;
  readonly submissions?: unknown;
}

export interface PreparedInteractionSubmission {
  /** The turn whose message carries the answered interactions. */
  readonly turnId: string;
  /** One entry per distinct interaction, in the order they were submitted. */
  readonly results: ReadonlyArray<{
    readonly submissionId: string;
    readonly interactionId: string;
    /** The values as stored: defaults applied, numbers and booleans coerced. */
    readonly values: Readonly<Record<string, unknown>>;
    readonly filledNarrative: string;
  }>;
  /**
   * What the follow-up turn takes as the player's message: the filled
   * narratives, one per line. Empty when every interaction declares
   * `submitBehavior.echoFilledNarrative: false`.
   */
  readonly playerMessage: string;
  /** Store the answers. Call it in the transaction that starts the turn. */
  persist(target: Pick<DataStore, "savePlayerInput">): Promise<void>;
}

interface MessageLike {
  readonly turnId: string;
  readonly sourceType: string;
  readonly role: string;
  readonly pendingInput?: unknown;
  readonly content: string;
  readonly name?: string;
  readonly sourcePluginId?: string;
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

/**
 * What the player reads when a form is refused. Written for the player, not
 * the client: it names the field by its label and says what to change.
 */
const FORM_REFUSALS = {
  required: {
    "en-US": 'Fill in "{label}".',
    "zh-CN": "请填写“{label}”。",
    "ru-RU": "Заполните поле «{label}».",
  },
  invalid: {
    "en-US": '"{label}" has a value this form cannot take.',
    "zh-CN": "“{label}”的值不符合表单要求。",
    "ru-RU": "Поле «{label}» содержит недопустимое значение.",
  },
  number: {
    "en-US": '"{label}" must be a number.',
    "zh-CN": "“{label}”必须是数字。",
    "ru-RU": "В поле «{label}» нужно ввести число.",
  },
  range: {
    "en-US": '"{label}" must be from {min} to {max}.',
    "zh-CN": "“{label}”必须在 {min} 到 {max} 之间。",
    "ru-RU": "Значение поля «{label}» должно быть от {min} до {max}.",
  },
  min: {
    "en-US": '"{label}" must be at least {min}.',
    "zh-CN": "“{label}”不能小于 {min}。",
    "ru-RU": "Значение поля «{label}» должно быть не меньше {min}.",
  },
  max: {
    "en-US": '"{label}" must be at most {max}.',
    "zh-CN": "“{label}”不能大于 {max}。",
    "ru-RU": "Значение поля «{label}» должно быть не больше {max}.",
  },
  step: {
    "en-US": '"{label}" must change in steps of {step}.',
    "zh-CN": "“{label}”必须按 {step} 的步长填写。",
    "ru-RU": "Значение поля «{label}» должно меняться с шагом {step}.",
  },
  tooLong: {
    "en-US": '"{label}" must be at most {max} characters.',
    "zh-CN": "“{label}”不能超过 {max} 个字符。",
    "ru-RU": "Поле «{label}» должно содержать не более {max} символов.",
  },
  option: {
    "en-US": 'Choose one of the listed options for "{label}".',
    "zh-CN": "请为“{label}”选择列表中的一项。",
    "ru-RU": "Выберите для поля «{label}» один из предложенных вариантов.",
  },
} as const satisfies Record<string, I18nText>;

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

export function findCommittedInteraction(
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
    throw new InteractionSubmissionError(
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
  locale: string,
): Record<string, unknown> {
  if (!Array.isArray(interaction.fields)) {
    throw new InteractionSubmissionError(
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
      throw new InteractionSubmissionError(
        `Committed form ${interaction.interactionId} contains a field without a name`,
      );
    }
    declared.set(name, field);
  }
  assertOnlyKeys(values, new Set(declared.keys()), interaction.interactionId);

  const normalizedValues: Record<string, unknown> = { ...values };
  const issues: FormIssue[] = [];
  for (const [name, field] of declared) {
    const refuse = (
      reason: keyof typeof FORM_REFUSALS,
      params: Record<string, unknown> = {},
    ): FormIssue => {
      const filled: Record<string, unknown> = {
        label: typeof field.label === "string" ? field.label : name,
        ...params,
      };
      return {
        field: name,
        message: resolveLabel(FORM_REFUSALS[reason], locale).replace(
          /\{(\w+)\}/g,
          (match, key: string) => (key in filled ? String(filled[key]) : match),
        ),
      };
    };
    const submitted = values[name];
    const value =
      (submitted === undefined ||
        (field.type !== "number" && isMissingRequired(submitted))) &&
      field.defaultValue !== undefined
        ? field.defaultValue
        : submitted;
    if (value !== undefined) normalizedValues[name] = value;
    if (field.required === true && isMissingRequired(value)) {
      issues.push(refuse("required"));
      continue;
    }
    if (isMissingRequired(value)) {
      delete normalizedValues[name];
      continue;
    }

    switch (field.type) {
      case "text":
      case "textarea":
        if (typeof value !== "string") {
          issues.push(refuse("invalid"));
          continue;
        }
        // The answer becomes the player's message of the turn that follows,
        // and the retry of that turn sends it as one.
        if (value.length > MAX_PLAYER_MESSAGE_CHARS) {
          issues.push(refuse("tooLong", { max: MAX_PLAYER_MESSAGE_CHARS }));
          continue;
        }
        break;
      case "number": {
        if (!(
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" &&
            value.trim().length > 0 &&
            Number.isFinite(Number(value)))
        )) {
          {
            issues.push(refuse("number"));
            continue;
          }
        }
        const numeric = Number(value);
        const { min, max } = field;
        if (
          (typeof min === "number" && numeric < min) ||
          (typeof max === "number" && numeric > max)
        ) {
          issues.push(
            refuse(
              typeof min !== "number"
                ? "max"
                : typeof max !== "number"
                  ? "min"
                  : "range",
              { min, max },
            ),
          );
          continue;
        }
        if (typeof field.step === "number") {
          const base = typeof min === "number" ? min : 0;
          const steps = (numeric - base) / field.step;
          if (
            !(field.step > 0) ||
            !Number.isFinite(steps) ||
            Math.abs(steps - Math.round(steps)) > 1e-8
          ) {
            issues.push(refuse("step", { step: field.step }));
            continue;
          }
        }
        normalizedValues[name] = numeric;
        break;
      }
      case "checkbox":
        if (
          typeof value !== "boolean" &&
          value !== "true" &&
          value !== "false"
        ) {
          {
            issues.push(refuse("invalid"));
            continue;
          }
        }
        normalizedValues[name] = value === true || value === "true";
        break;
      case "select": {
        if (typeof value !== "string") {
          issues.push(refuse("invalid"));
          continue;
        }
        const allowed = Array.isArray(field.options)
          ? field.options.map(optionValue).filter((item) => item !== undefined)
          : [];
        if (!allowed.includes(value)) {
          issues.push(refuse("option"));
          continue;
        }
        break;
      }
      default:
        throw new InteractionSubmissionError(
          `Committed form ${interaction.interactionId} has unsupported field type: ${String(field.type)}`,
        );
    }
  }
  if (issues.length > 0) throw new FormRejectedError(issues);
  return normalizedValues;
}

function validateSubmissionValues(
  sub: Submission,
  interaction: LocatedInteraction["interaction"],
  locale: string,
): Record<string, unknown> {
  if (sub.type !== interaction.type) {
    throw new InteractionSubmissionError(
      `Submission type must match committed interaction type "${interaction.type}" for interactionId: ${sub.interactionId}`,
    );
  }

  switch (interaction.type) {
    case "form":
      return validateFormValues(interaction, sub.values, locale);
    case "choice": {
      assertOnlyKeys(
        sub.values,
        new Set(["selectedId", "selectedLabel"]),
        sub.interactionId,
      );
      const selectedId = sub.values.selectedId;
      if (typeof selectedId !== "string" || !selectedId) {
        throw new InteractionSubmissionError(
          `selectedId (string) is required for interactionId: ${sub.interactionId}`,
        );
      }
      const choices = Array.isArray(interaction.choices)
        ? (interaction.choices as Array<Record<string, unknown>>)
        : [];
      const selected = choices.find((choice) => choice.id === selectedId);
      if (!selected || typeof selected.label !== "string") {
        throw new InteractionSubmissionError(
          `selectedId must match a declared choice for interactionId: ${sub.interactionId}`,
        );
      }
      return { selectedId, selectedLabel: selected.label };
    }
    case "confirmation":
      assertOnlyKeys(sub.values, new Set(["confirmed"]), sub.interactionId);
      if (typeof sub.values.confirmed !== "boolean") {
        throw new InteractionSubmissionError(
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
  // A choice or confirmation takes its template from the interaction only.
  // The message that carries it holds the runtime's own text, so reading that
  // as a template would return the AI's prose as the player's answer.
  let template = sub.type === "form" ? located.message.content : "";
  if (typeof located.interaction.narrativeTemplate === "string") {
    template = located.interaction.narrativeTemplate;
  }
  if (!template) return fallbackNarrative(sub, labels, located.interaction);

  const replacements = buildReplacements(sub, labels);
  return template.replace(
    /\{\{\s*([^}]+?)\s*\}\}([。.]?)/g,
    (_match, key: string, fullStop: string) => {
      const value = replacements[key.trim()];
      const rendered =
        value !== undefined && value !== null ? String(value) : "";
      // Preserve the submitted text; omit only a duplicate template full stop.
      return fullStop && rendered.endsWith(fullStop)
        ? rendered
        : rendered + fullStop;
    },
  );
}

const ALREADY_SUBMITTED = {
  "en-US": "This was already submitted. Reload to see the answer.",
  "zh-CN": "这一项已经提交过了。刷新后可以看到已提交的内容。",
  "ru-RU": "Этот ответ уже отправлен. Обновите страницу, чтобы увидеть его.",
} as const satisfies I18nText;

const ANSWER_TOO_LONG = {
  "en-US": "The answers are too long together: at most {max} characters.",
  "zh-CN": "填写的内容合起来太长：最多 {max} 个字符。",
  "ru-RU": "Ответы вместе слишком длинные: не более {max} символов.",
} as const satisfies I18nText;

/**
 * The submission was refused and nothing was stored. Without a subclass it
 * describes a request the client must not have sent.
 */
export class InteractionSubmissionError extends Error {
  readonly code: string = "invalid_interaction_submission";

  constructor(message: string) {
    super(message);
    this.name = "InteractionSubmissionError";
  }
}

/**
 * The player's values were refused and the form stays open for a correction.
 * The message is for the player, in the session's language.
 */
export class FormRejectedError extends InteractionSubmissionError {
  override readonly code = "form_rejected";
  /**
   * What was refused, one entry per reason. An issue with a `field` belongs to
   * that field of the form; one without belongs to the form as a whole.
   */
  readonly issues: readonly FormIssue[];

  constructor(issues: readonly FormIssue[]) {
    // `message` is the whole refusal as one text, for a client that does not
    // read `issues`.
    super(issues.map((issue) => issue.message).join("\n"));
    this.issues = issues;
  }
}

/**
 * The interaction already has a stored answer. The message is for the player,
 * in the session's language.
 */
export class InteractionAlreadySubmittedError extends InteractionSubmissionError {
  override readonly code = "interaction_already_submitted";
}

/**
 * Call the submitter under the session lock: the "already answered" check and
 * the caller's `persist` are one decision only while no other request writes.
 */
export function createInteractionSubmitter(
  validatePluginForm: ValidatePluginForm | undefined,
  store: Pick<DataStore, "listPlayerInputs" | "listTurnMessages">,
) {
  return async (
    payload: unknown,
    context: { readonly sessionId: string; readonly locale?: string },
  ): Promise<PreparedInteractionSubmission> => {
    const { sessionId } = context;
    const locale = context.locale ?? DEFAULT_LOCALE;
    const labels = resolveLabels(locale);

    if (!payload || typeof payload !== "object") {
      throw new InteractionSubmissionError("payload must be an object");
    }
    const body = payload as SubmissionPayload;

    if (!body.turnId || typeof body.turnId !== "string") {
      throw new InteractionSubmissionError("turnId (string) is required");
    }

    if (!Array.isArray(body.submissions) || body.submissions.length === 0) {
      throw new InteractionSubmissionError("submissions[] is required");
    }

    const submissions: Submission[] = [];
    for (const rawSubmission of body.submissions) {
      if (
        !rawSubmission ||
        typeof rawSubmission !== "object" ||
        Array.isArray(rawSubmission)
      ) {
        throw new InteractionSubmissionError(
          "Each submission must be an object",
        );
      }
      const sub = rawSubmission as Submission;
      if (!sub.interactionId || typeof sub.interactionId !== "string") {
        throw new InteractionSubmissionError(
          "Each submission requires interactionId (string)",
        );
      }
      if (!VALID_TYPES.has(sub.type)) {
        throw new InteractionSubmissionError(
          `Invalid submission type: ${sub.type}. Must be form|choice|confirmation`,
        );
      }
      if (
        !sub.values ||
        typeof sub.values !== "object" ||
        Array.isArray(sub.values)
      ) {
        throw new InteractionSubmissionError(
          `submission.values must be an object for interactionId: ${sub.interactionId}`,
        );
      }
      submissions.push(sub);
    }

    const messages = (await store.listTurnMessages(
      sessionId,
    )) as readonly MessageLike[];
    const existingInputs = await store.listPlayerInputs(sessionId);
    const prepared: Array<{
      readonly submissionId: string;
      readonly interactionId: string;
      readonly values: Record<string, unknown>;
      readonly filledNarrative: string;
      readonly echo: boolean;
    }> = [];
    const preparedByKey = new Map<string, (typeof prepared)[number]>();

    for (const sub of submissions) {
      const located = findCommittedInteraction(
        messages,
        body.turnId,
        sub.interactionId,
      );
      if (!located) {
        throw new InteractionSubmissionError(
          `No committed interaction found for turnId=${body.turnId}, interactionId=${sub.interactionId}`,
        );
      }
      const values = validateSubmissionValues(sub, located.interaction, locale);
      const validation = located.interaction.validation;
      if (validation !== undefined) {
        const pluginId = located.message.sourcePluginId;
        if (
          !pluginId ||
          !validation ||
          typeof validation !== "object" ||
          Array.isArray(validation)
        ) {
          throw new InteractionSubmissionError(
            "Committed form has invalid validation metadata",
          );
        }
        const { name, data } = validation as Record<string, unknown>;
        if (typeof name !== "string" || !name || !validatePluginForm) {
          throw new InteractionSubmissionError(
            "Form validator is unavailable; activate and approve its plugin first",
          );
        }
        let refusal: readonly FormIssue[] | undefined;
        try {
          refusal = await validatePluginForm({
            sessionId,
            pluginId,
            name,
            values,
            data,
          });
        } catch (error) {
          throw new InteractionSubmissionError(
            error instanceof Error ? error.message : "Form validation failed",
          );
        }
        if (refusal !== undefined && refusal.length > 0) {
          // A field the form does not have makes the issue a form-level one.
          const declared = new Set(
            (Array.isArray(located.interaction.fields)
              ? (located.interaction.fields as Array<Record<string, unknown>>)
              : []
            ).map((field) => field.name ?? field.id),
          );
          throw new FormRejectedError(
            refusal.map((issue) =>
              issue.field !== undefined && declared.has(issue.field)
                ? issue
                : { message: issue.message },
            ),
          );
        }
      }
      const normalizedSub: Submission = { ...sub, values };
      const key = `${body.turnId}\0${sub.interactionId}`;
      const duplicateInBatch = preparedByKey.get(key);
      if (duplicateInBatch) {
        if (stableJson(duplicateInBatch.values) !== stableJson(values)) {
          throw new InteractionSubmissionError(
            `Interaction ${sub.interactionId} is submitted more than once with conflicting values`,
          );
        }
        continue;
      }

      // One answer per interaction. The answer is stored in the transaction
      // that starts its follow-up turn, so a stored answer means the turn
      // exists: a second submit is refused whatever its values, and the
      // client reads the turn instead.
      if (
        existingInputs.some(
          (input) =>
            input.turnId === body.turnId && input.formId === sub.interactionId,
        )
      ) {
        throw new InteractionAlreadySubmittedError(
          resolveLabel(ALREADY_SUBMITTED, locale),
        );
      }
      const submitBehavior = located.interaction.submitBehavior as
        { readonly echoFilledNarrative?: unknown } | undefined;
      const item = {
        submissionId: crypto.randomUUID(),
        interactionId: sub.interactionId,
        values,
        filledNarrative: fillTemplate(normalizedSub, located, labels),
        echo: submitBehavior?.echoFilledNarrative !== false,
      };
      prepared.push(item);
      preparedByKey.set(key, item);
    }

    const playerMessage = prepared
      .filter((item) => item.echo && item.filledNarrative)
      .map((item) => item.filledNarrative)
      .join("\n");
    // Fields that each fit can still add up to more than one message holds.
    if (playerMessage.length > MAX_PLAYER_MESSAGE_CHARS) {
      throw new FormRejectedError([
        {
          message: resolveLabel(ANSWER_TOO_LONG, locale).replace(
            "{max}",
            String(MAX_PLAYER_MESSAGE_CHARS),
          ),
        },
      ]);
    }

    return {
      turnId: body.turnId,
      results: prepared.map((item) => ({
        submissionId: item.submissionId,
        interactionId: item.interactionId,
        values: item.values,
        filledNarrative: item.filledNarrative,
      })),
      playerMessage,
      persist: async (target) => {
        const createdAt = new Date().toISOString();
        for (const item of prepared) {
          await target.savePlayerInput({
            id: item.submissionId,
            sessionId,
            turnId: body.turnId,
            formId: item.interactionId,
            values: item.values,
            createdAt,
          });
        }
      },
    };
  };
}
