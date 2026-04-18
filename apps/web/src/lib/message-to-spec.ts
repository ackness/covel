/**
 * Convert game messages to json-render specs.
 *
 * All message rendering goes through json-render — narrative text, forms,
 * notifications, player messages. This module converts each V1 StreamMessage
 * to a nested spec tree, which chat-messages.tsx then flattens via
 * `nestedToFlat` and hands to `@json-render/react` Renderer.
 */

import type { StreamMessage } from "@/stores/session-store.js";

type NestedSpec = Record<string, unknown>;

/**
 * Convert a StreamMessage to a disabled spec (post-submission state).
 * All interactive elements are disabled, submit button shows "已提交" so
 * the historical block is clearly frozen.
 */
export function messageToSpecDisabled(msg: StreamMessage): NestedSpec | null {
  if (!msg.block) return messageToSpec(msg);

  const block = msg.block;
  const data = (block.data ?? block) as Record<string, unknown>;
  const type = block.type as string;
  const innerType = data.type as string | undefined;

  // Form → disabled version
  if (innerType === "form" || type === "interactive_form" || (data.fields && Array.isArray(data.fields))) {
    return formToSpecDisabled(data);
  }

  // Choice → disabled version
  if (innerType === "choice" || type === "interactive_choice") {
    return {
      type: "Stack",
      props: { gap: "sm" },
      children: [
        { type: "Text", props: { content: data.prompt ?? "", variant: "muted" } },
        { type: "Text", props: { content: "已选择", variant: "muted", size: "xs" } },
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
  if (innerType === "form" || type === "interactive_form" || (data.fields && Array.isArray(data.fields))) {
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
  const title = (data.title as string) ?? "表单";
  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    options?: string[] | Array<{ value: string; label: string }>;
  }>;
  const submitLabel = (data.submitLabel as string) ?? "提交";
  const narrativeTemplate = data.narrativeTemplate as string | undefined;

  const children: NestedSpec[] = [
    { type: "FormHeader", props: { title } },
  ];

  // Narrative template (italic intro text)
  if (narrativeTemplate) {
    const preview = narrativeTemplate.replace(/\{\{[^}]+\}\}/g, "___").slice(0, 200);
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
 */
function formToSpecDisabled(data: Record<string, unknown>): NestedSpec {
  const title = (data.title as string) ?? "表单";
  const submitBehavior = data.submitBehavior as Record<string, unknown> | undefined;
  if (submitBehavior?.autoContinue === true) {
    return {
      type: "Stack",
      props: { gap: "xs" },
      children: [
        { type: "FormHeader", props: { title } },
        { type: "Text", props: { content: "已提交，故事继续推进。", variant: "muted", size: "sm" } },
      ],
    };
  }

  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    options?: string[] | Array<{ value: string; label: string }>;
  }>;

  const children: NestedSpec[] = [
    { type: "FormHeader", props: { title } },
  ];

  for (const field of fields) {
    const options = field.options?.map((opt) =>
      typeof opt === "string" ? { value: opt, label: opt } : opt,
    );
    children.push({
      type: "FormField",
      props: {
        fieldType: field.type === "select" ? "select" : "text",
        label: field.label ?? field.name,
        options,
        disabled: true,
        value: { $bindState: `/form/${field.name}` },
      },
    });
  }

  children.push({
    type: "SubmitButton",
    props: { label: "已提交", disabled: true },
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
  const choices = (data.choices ?? []) as Array<{ id: string; label: string; description?: string }>;

  const children: NestedSpec[] = [];
  if (prompt) {
    children.push({ type: "Text", props: { content: prompt, variant: "muted" } });
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
