/**
 * InteractionBlock — renders interactive blocks (forms, choices, notifications).
 *
 * These come from plugin tools like create-form, create-choices, create-notification.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { sendMessage } from "@/stores/session-store.js";

interface InteractionBlockProps {
  block: Record<string, unknown>;
}

export function InteractionBlock({ block }: InteractionBlockProps) {
  const type = block.type as string;
  // The actual interaction type may be in block.data.type (framework wraps with block type like "interactive_form")
  const innerType = (block.data as Record<string, unknown> | undefined)?.type as string | undefined;
  const resolved = innerType ?? type;

  switch (resolved) {
    case "form":
    case "interactive_form":
      return <FormBlock block={block} />;
    case "choice":
    case "interactive_choice":
      return <ChoiceBlock block={block} />;
    case "notification":
      return <NotificationBlock block={block} />;
    default: {
      // Try to detect form-like blocks by checking for fields array in data
      const data = block.data as Record<string, unknown> | undefined;
      if (data?.fields && Array.isArray(data.fields)) {
        return <FormBlock block={block} />;
      }
      return (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 text-xs">
          <span className="text-zinc-400">Block: {type}</span>
          <pre className="mt-1 text-[10px] text-zinc-500 overflow-x-auto max-h-32">
            {JSON.stringify(block, null, 2).slice(0, 500)}
          </pre>
        </div>
      );
    }
  }
}

// ── Form Block ───────────────────────────────────────────────────

function FormBlock({ block }: { block: Record<string, unknown> }) {
  const data = (block.data ?? block) as Record<string, unknown>;
  const title = data.title as string ?? "表单";
  const fields = (data.fields ?? []) as Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    options?: Array<{ value: string; label: string }>;
  }>;
  const submitLabel = data.submitLabel as string ?? "提交";
  const narrativeTemplate = data.narrativeTemplate as string;
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    if (submitted) return;
    setSubmitted(true);

    // Build narrative from template
    let text = narrativeTemplate ?? "";
    for (const [key, val] of Object.entries(values)) {
      text = text.replaceAll(`{{${key}}}`, val);
    }

    // Send as player message with form data
    const formSummary = fields.map((f) => `${f.label ?? f.name}: ${values[f.name] ?? ""}`).join(", ");
    sendMessage(formSummary || text || submitLabel);
  };

  const allRequiredFilled = fields
    .filter((f) => f.required)
    .every((f) => values[f.name]?.trim());

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      <div className="bg-zinc-50 dark:bg-zinc-800/50 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <span className="text-xs font-medium">{title}</span>
      </div>
      <div className="p-4 space-y-3">
        {narrativeTemplate && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed italic">
            {narrativeTemplate.replace(/\{\{[^}]+\}\}/g, "___")}
          </p>
        )}
        {fields.map((field) => (
          <div key={field.name} className="space-y-1">
            <label className="text-xs text-zinc-500">
              {field.label ?? field.name}
              {field.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            {field.type === "select" ? (
              <select
                value={values[field.name] ?? ""}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                disabled={submitted}
                className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm rounded-md"
              >
                <option value="">{field.placeholder ?? `选择${field.label ?? field.name}`}</option>
                {field.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={values[field.name] ?? ""}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                placeholder={field.placeholder}
                disabled={submitted}
                className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm rounded-md"
              />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitted || !allRequiredFilled}
          className={clsx(
            "w-full py-2 text-sm font-medium rounded-md transition-colors",
            submitted
              ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {submitted ? "已提交" : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Choice Block ─────────────────────────────────────────────────

function ChoiceBlock({ block }: { block: Record<string, unknown> }) {
  const data = (block.data ?? block) as Record<string, unknown>;
  const prompt = data.prompt as string ?? "";
  const choices = (data.choices ?? []) as Array<{ id: string; label: string; description?: string }>;
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (choice: { id: string; label: string }) => {
    if (selected) return;
    setSelected(choice.id);
    sendMessage(choice.label);
  };

  return (
    <div className="space-y-2">
      {prompt && <p className="text-sm text-zinc-600 dark:text-zinc-400">{prompt}</p>}
      <div className="grid gap-2">
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            onClick={() => handleSelect(choice)}
            disabled={selected !== null}
            className={clsx(
              "text-left px-4 py-2.5 border rounded-lg text-sm transition-colors",
              selected === choice.id
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                : selected !== null
                  ? "border-zinc-200 dark:border-zinc-700 opacity-50 cursor-not-allowed"
                  : "border-zinc-200 dark:border-zinc-700 hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 cursor-pointer",
            )}
          >
            <span className="font-medium">{choice.label}</span>
            {choice.description && (
              <span className="text-zinc-500 text-xs block mt-0.5">{choice.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Notification Block ───────────────────────────────────────────

function NotificationBlock({ block }: { block: Record<string, unknown> }) {
  const data = (block.data ?? block) as Record<string, unknown>;
  const level = data.level as string ?? "info";
  const title = data.title as string;
  const message = data.message as string;

  const colors: Record<string, string> = {
    success: "border-emerald-500/30 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400",
    warning: "border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-400",
    error: "border-red-500/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400",
    info: "border-blue-500/30 bg-blue-50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-400",
  };

  return (
    <div className={clsx("border rounded-lg px-4 py-2.5 text-sm", colors[level])}>
      {title && <div className="font-medium text-xs">{title}</div>}
      {message && <div className="text-xs mt-0.5 opacity-80">{message}</div>}
    </div>
  );
}
