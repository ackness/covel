/**
 * Convert game messages to json-render specs.
 *
 * All message rendering goes through json-render — narrative text, forms,
 * notifications, player messages. This module converts each message type
 * to a nested spec tree, which plugin-panel.tsx then flattens and renders.
 */

import type { GameMessage } from "@/stores/session-store.js";

type NestedSpec = Record<string, unknown>;

/**
 * Convert a GameMessage to a json-render nested spec.
 * Returns null for messages that should not be rendered (empty, system).
 */
export function messageToSpec(msg: GameMessage): NestedSpec | null {
  // Player message
  if (msg.role === "user") {
    return {
      type: "PlayerMessage",
      props: { content: msg.content },
    };
  }

  // Block message (interactive form, notification, etc.)
  if (msg.block) {
    return blockToSpec(msg.block);
  }

  // Narrative text
  if (msg.role === "assistant" && msg.content) {
    const children: NestedSpec[] = [
      { type: "Prose", props: { content: msg.content } },
    ];
    if (msg.pluginId) {
      children.push({ type: "Source", props: { label: msg.pluginId } });
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

  // Codex discovery
  if (type === "codex-discovery" || type === "codex_entry") {
    return {
      type: "EntryCard",
      props: {
        title: data.title ?? "",
        category: data.category ?? "lore",
        content: data.content ?? "",
        tags: data.tags ?? [],
        rarity: data.rarity ?? "common",
      },
    };
  }

  // Unknown block — raw display
  return {
    type: "Card",
    children: [
      { type: "Text", props: { content: `Block: ${type}`, variant: "muted", size: "xs" } },
      { type: "Text", props: { content: JSON.stringify(data, null, 2).slice(0, 300), size: "xs" } },
    ],
  };
}

/**
 * Convert a form block to a json-render nested spec.
 */
function formToSpec(data: Record<string, unknown>): NestedSpec {
  const title = data.title as string ?? "表单";
  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    options?: string[] | Array<{ value: string; label: string }>;
  }>;
  const submitLabel = data.submitLabel as string ?? "提交";
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
 * Convert a choice block to a json-render nested spec.
 */
function choiceToSpec(data: Record<string, unknown>): NestedSpec {
  const prompt = data.prompt as string ?? "";
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
