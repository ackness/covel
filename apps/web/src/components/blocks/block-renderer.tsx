/**
 * Block Renderer — Three-Tier Resolution
 *
 * Tier 1: Custom Renderer — hand-written React component (highest quality)
 * Tier 2: Schema Renderer — auto-generated from plugin blockSchemas
 * Tier 3: Raw Fallback — JSON display (development/debug)
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SchemaBlockRenderer } from "./schema-block-renderer.js";
import type { BlockSchemaDeclaration } from "@covel/shared";

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

// ── Tier 1: Custom Renderers ──────────────────────────────────────

const CUSTOM_RENDERERS: Record<string, BlockRendererComponent> = {
  choice_set: ChoiceSetBlock,
  character_creation: CharacterCreationBlock,
};

// ── Tier 2: Schema Registry ──────────────────────────────────────

let blockSchemas: Record<string, BlockSchemaDeclaration> = {};

export function setBlockSchemas(schemas: Record<string, BlockSchemaDeclaration>) {
  blockSchemas = schemas;
}

export function getBlockSchemas(): Record<string, BlockSchemaDeclaration> {
  return blockSchemas;
}

// ── Resolution ────────────────────────────────────────────────────

export interface BlockResolution {
  mode: "custom" | "schema" | "raw";
  component?: BlockRendererComponent;
  schema?: BlockSchemaDeclaration;
}

export function resolveBlockRenderer(blockType: string): BlockResolution {
  if (CUSTOM_RENDERERS[blockType]) {
    return { mode: "custom", component: CUSTOM_RENDERERS[blockType] };
  }
  if (blockSchemas[blockType]) {
    return { mode: "schema", schema: blockSchemas[blockType] };
  }
  return { mode: "raw" };
}

/**
 * Legacy API — resolve to a renderable component.
 * Returns null only if no custom renderer AND no schema available (raw fallback).
 */
export function getBlockRenderer(blockType: string): BlockRendererComponent | null {
  const resolution = resolveBlockRenderer(blockType);

  if (resolution.mode === "custom" && resolution.component) {
    return resolution.component;
  }

  if (resolution.mode === "schema" && resolution.schema) {
    const schema = resolution.schema;
    return function SchemaBlock(props: BlockRendererProps) {
      return (
        <SchemaBlockRenderer
          schema={schema}
          data={props.data}
          onSubmit={props.onSubmit}
          disabled={props.disabled}
        />
      );
    };
  }

  return null;
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
