/**
 * Convert game messages to json-render specs.
 *
 * All message rendering goes through json-render — narrative text, forms,
 * notifications, player messages. This module converts each V1 StreamMessage
 * to a nested spec tree, which chat-messages.tsx then flattens via
 * `nestedToFlat` and hands to `@json-render/react` Renderer.
 */

import i18n from "@/i18n";
import type { StreamMessage } from "@/stores/session-store.js";

type NestedSpec = Record<string, unknown>;

const tr = (key: string, vars?: Record<string, unknown>): string =>
  i18n.t(key, vars) as string;

/**
 * Convert a StreamMessage to a disabled spec (post-submission state).
 * All interactive elements are disabled, submit button shows "已提交" so
 * the historical block is clearly frozen. Submitted form values (when
 * available) are baked back into the spec so the player can see what they
 * entered.
 */
export function messageToSpecDisabled(
  msg: StreamMessage,
  submittedValues?: Record<string, unknown>,
): NestedSpec | null {
  if (!msg.block) return messageToSpec(msg);

  const block = msg.block;
  const data = (block.data ?? block) as Record<string, unknown>;
  const type = block.type as string;
  const innerType = data.type as string | undefined;

  // Form → disabled version
  if (
    innerType === "form" ||
    type === "interactive_form" ||
    (data.fields && Array.isArray(data.fields))
  ) {
    return formToSpecDisabled(data, submittedValues);
  }

  // Choice → disabled version
  if (innerType === "choice" || type === "interactive_choice") {
    return {
      type: "Stack",
      props: { gap: "sm" },
      children: [
        {
          type: "Text",
          props: { content: data.prompt ?? "", variant: "muted" },
        },
        {
          type: "Text",
          props: {
            content: tr("form.submittedHint"),
            variant: "muted",
            size: "xs",
          },
        },
      ],
    };
  }

  return messageToSpec(msg);
}

/**
 * Convert a StreamMessage to a json-render nested spec.
 * Returns null for messages that should not be rendered (empty, system).
 */
export function messageToSpec(msg: StreamMessage): NestedSpec | null {
  // Player message — right-aligned bubble
  if (msg.role === "user") {
    return {
      type: "PlayerMessage",
      props: { content: msg.content },
    };
  }

  // Block message (interactive form, notification, choice)
  if (msg.block) {
    return blockToSpec(msg.block);
  }

  // Narrative / story text
  if (msg.role === "assistant" && msg.content) {
    const children: NestedSpec[] = [
      { type: "Prose", props: { content: msg.content } },
    ];
    if (msg.runtimeId) {
      children.push({ type: "Source", props: { label: msg.runtimeId } });
    }
    return {
      type: "Stack",
      props: { gap: "xs" },
      children,
    };
  }

  return null;
}

/**
 * Convert an interaction block to a json-render nested spec.
 *
 * Framework-owned block types (form, choice, notification, ui-spec) are
 * handled here. Anything else falls through to `null` and renders as raw
 * JSON. Plugins that want a custom inline UI should emit a `ui-spec` block
 * carrying a nested json-render spec tree — this keeps the framework
 * agnostic to plugin-specific block type strings.
 */
function blockToSpec(block: Record<string, unknown>): NestedSpec | null {
  const type = block.type as string;
  const data = (block.data ?? block) as Record<string, unknown>;
  const innerType = data.type as string | undefined;

  // Form / interactive_form
  if (
    innerType === "form" ||
    type === "interactive_form" ||
    (data.fields && Array.isArray(data.fields))
  ) {
    return formToSpec(data);
  }

  // Notification
  if (type === "notification" || innerType === "notification") {
    return {
      type: "Alert",
      props: {
        level: data.level ?? "info",
        title: data.title ?? "",
        message: data.message ?? "",
      },
    };
  }

  // Choice
  if (innerType === "choice" || type === "interactive_choice") {
    return choiceToSpec(data);
  }

  // Plugin-authored inline UI. Convention: `block.type === "ui-spec"` (or
  // `data.type === "ui-spec"`), with a `spec` field carrying the nested
  // json-render tree. The spec's root component must be registered in the
  // catalog — unregistered components just render as nothing.
  if (type === "ui-spec" || innerType === "ui-spec") {
    const spec = data.spec as NestedSpec | undefined;
    if (spec && typeof spec === "object" && typeof spec.type === "string") {
      return spec;
    }
    return null;
  }

  // Unknown block — raw display
  return null;
}

/**
 * Convert a form block to a json-render nested spec.
 */
function formToSpec(data: Record<string, unknown>): NestedSpec {
  const title = (data.title as string) ?? tr("form.defaultTitle");
  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    options?: string[] | Array<{ value: string; label: string }>;
  }>;
  const submitLabel = (data.submitLabel as string) ?? tr("form.submit");
  const narrativeTemplate = data.narrativeTemplate as string | undefined;

  const children: NestedSpec[] = [{ type: "FormHeader", props: { title } }];

  // Narrative template (italic intro text)
  if (narrativeTemplate) {
    const preview = narrativeTemplate
      .replace(/\{\{[^}]+\}\}/g, "___")
      .slice(0, 200);
    children.push({
      type: "Text",
      props: { content: preview, variant: "muted", size: "sm" },
    });
  }

  // Form fields
  for (const field of fields) {
    const options = field.options?.map((opt) =>
      typeof opt === "string" ? { value: opt, label: opt } : opt,
    );

    children.push({
      type: "FormField",
      props: {
        fieldType: field.type === "select" ? "select" : "text",
        label: field.label ?? field.name,
        placeholder: field.placeholder,
        required: field.required,
        options,
        value: { $bindState: `/form/${field.name}` },
      },
    });
  }

  // Submit button
  children.push({
    type: "SubmitButton",
    props: { label: submitLabel },
    on: {
      click: {
        action: "submitForm",
        params: { formId: data.interactionId ?? data.formId ?? "form" },
      },
    },
  });

  return {
    type: "Form",
    children,
  };
}

/**
 * Convert a form block to a disabled json-render spec (post-submission).
 * If `submittedValues` is provided, each field's submitted value is rendered
 * inline (as static `value` and `placeholder`) so the player can see what
 * they originally entered without depending on a live state tree.
 */
function formToSpecDisabled(
  data: Record<string, unknown>,
  submittedValues?: Record<string, unknown>,
): NestedSpec {
  const title = (data.title as string) ?? tr("form.defaultTitle");

  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    options?: string[] | Array<{ value: string; label: string }>;
  }>;

  const children: NestedSpec[] = [{ type: "FormHeader", props: { title } }];

  for (const field of fields) {
    const options = field.options?.map((opt) =>
      typeof opt === "string" ? { value: opt, label: opt } : opt,
    );
    const raw = submittedValues?.[field.name];
    const submittedValue = raw === undefined || raw === null ? "" : String(raw);
    const props: Record<string, unknown> = {
      fieldType: field.type === "select" ? "select" : "text",
      label: field.label ?? field.name,
      options,
      disabled: true,
    };
    if (submittedValue) {
      props.value = submittedValue;
      props.placeholder = submittedValue;
    } else {
      // No persisted value (legacy submissions) — fall back to live state binding.
      props.value = { $bindState: `/form/${field.name}` };
    }
    children.push({ type: "FormField", props });
  }

  children.push({
    type: "SubmitButton",
    props: { label: tr("form.submitted"), disabled: true },
  });

  return {
    type: "Form",
    children,
  };
}

/**
 * Convert a choice block to a json-render nested spec.
 */
function choiceToSpec(data: Record<string, unknown>): NestedSpec {
  const prompt = (data.prompt as string) ?? "";
  const choices = (data.choices ?? []) as Array<{
    id: string;
    label: string;
    description?: string;
  }>;

  const children: NestedSpec[] = [];
  if (prompt) {
    children.push({
      type: "Text",
      props: { content: prompt, variant: "muted" },
    });
  }

  for (const choice of choices) {
    children.push({
      type: "Button",
      props: { label: choice.label, variant: "default" },
      on: {
        click: {
          action: "selectChoice",
          params: { choiceId: choice.id, label: choice.label },
        },
      },
    });
  }

  return {
    type: "Stack",
    props: { gap: "sm" },
    children,
  };
}
