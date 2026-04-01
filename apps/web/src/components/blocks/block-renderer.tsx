/**
 * Block Renderer Registry
 *
 * Extensible rendering system for plugin-emitted UI blocks.
 * Each block type (choice_set, character_creation, etc.) has a dedicated
 * renderer component. New plugin block types can be added by registering
 * a renderer in the BLOCK_RENDERERS map below.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// ── Types ──────────────────────────────────────────────────────────

export interface BlockRendererProps {
  /** Block data payload from the server. */
  data: Record<string, unknown>;
  /** Callback to send a message/response back to the server. */
  onSubmit: (value: string) => void;
  /** Whether the session is currently executing (disable interactions). */
  disabled?: boolean;
}

type BlockRendererComponent = React.ComponentType<BlockRendererProps>;

// ── Registry ───────────────────────────────────────────────────────

/**
 * Map of block type → renderer component.
 * To add a new plugin block type, add an entry here.
 */
const BLOCK_RENDERERS: Record<string, BlockRendererComponent> = {
  choice_set: ChoiceSetBlock,
  character_creation: CharacterCreationBlock,
};

/**
 * Resolve the renderer for a given block type.
 * Returns null if no renderer is registered (caller should use fallback).
 */
export function getBlockRenderer(blockType: string): BlockRendererComponent | null {
  return BLOCK_RENDERERS[blockType] ?? null;
}

// ── choice_set ─────────────────────────────────────────────────────

function ChoiceSetBlock({ data, onSubmit, disabled }: BlockRendererProps) {
  const title = data.title as string | undefined;
  const options = (data.options as Array<{ id: string; label: string }>) ?? [];

  return (
    <Card className="max-w-md">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-sm">{title ?? "Choose"}</CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        {options.map((opt) => (
          <Button
            key={opt.id}
            variant="ghost"
            className="w-full justify-start rounded-none text-sm h-auto py-3 px-4"
            disabled={disabled}
            onClick={() => onSubmit(opt.label)}
          >
            {opt.label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

// ── character_creation ─────────────────────────────────────────────

function CharacterCreationBlock({ data, onSubmit, disabled }: BlockRendererProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  const title = data.title as string | undefined;
  const description = data.description as string | undefined;
  const fields = (data.fields as Array<{
    id: string;
    type: string;
    label: string;
    placeholder?: string;
    required?: boolean;
  }>) ?? [];
  const submitLabel = (data.submitLabel as string) ?? "Submit";

  const handleFieldChange = (fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSubmit = () => {
    // Collect field values and send as message
    // For single-field forms (like character name), send the value directly
    // For multi-field forms, send as structured text
    if (fields.length === 1) {
      const value = values[fields[0].id]?.trim();
      if (value) onSubmit(value);
    } else {
      const parts = fields
        .map((f) => values[f.id]?.trim())
        .filter(Boolean);
      if (parts.length > 0) onSubmit(parts.join(", "));
    }
  };

  const canSubmit = fields
    .filter((f) => f.required)
    .every((f) => values[f.id]?.trim());

  return (
    <Card className="max-w-md">
      <CardHeader className="py-3 px-4 border-b border-border space-y-1">
        <CardTitle className="text-sm">{title ?? "Character Setup"}</CardTitle>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {fields.map((field) => (
          <div key={field.id} className="space-y-1.5">
            <label htmlFor={`block-field-${field.id}`} className="text-xs font-medium uppercase tracking-wider">
              {field.label}
              {field.required && <span className="text-destructive ml-0.5">*</span>}
            </label>
            <input
              id={`block-field-${field.id}`}
              type={field.type === "text" ? "text" : field.type}
              placeholder={field.placeholder}
              value={values[field.id] ?? ""}
              onChange={(e) => handleFieldChange(field.id, e.target.value)}
              disabled={disabled}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit && !disabled) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50"
            />
          </div>
        ))}
        <Button
          className="w-full rounded-none uppercase tracking-widest text-xs font-semibold"
          disabled={disabled || !canSubmit}
          onClick={handleSubmit}
        >
          {submitLabel}
        </Button>
      </CardContent>
    </Card>
  );
}
