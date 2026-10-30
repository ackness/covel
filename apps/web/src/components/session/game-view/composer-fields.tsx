import { useCallback, useMemo } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { ComposerField } from "@covel/shared";
import { covelRegistry } from "@/lib/catalog.js";
import { covelDirectives } from "@/lib/json-render-directives.js";
import {
  formFieldsToSpec,
  type FormFieldDefinition,
} from "@/lib/message-to-spec.js";
import type { ComposerModes } from "./use-composer-modes.js";

function fieldDefinition(field: ComposerField): FormFieldDefinition {
  const base = {
    name: field.name,
    label: field.label,
    required: field.required,
    ...(field.description ? { placeholder: field.description } : {}),
  };
  switch (field.control) {
    case "select":
      return { ...base, type: "select", options: [...field.options] };
    case "number":
      return {
        ...base,
        type: "number",
        ...(field.minimum !== undefined ? { min: field.minimum } : {}),
        ...(field.maximum !== undefined ? { max: field.maximum } : {}),
        ...(field.integer ? { step: 1 } : {}),
      };
    default:
      return { ...base, type: field.control };
  }
}

const FORM_PATH = /^\/form\/(.+)$/;

/**
 * The inputs of the selected mode's fields, drawn with the form field
 * components. The values live in the composer's mode state, which is also
 * where a stopped submission puts them back.
 */
export function ComposerFields({
  composerModes,
}: {
  composerModes: ComposerModes;
}) {
  const { mode, fieldValues, fieldsKey, setFieldValue } = composerModes;
  const spec = useMemo(
    () =>
      nestedToFlat({
        type: "Stack",
        props: { gap: "sm" },
        children: formFieldsToSpec(mode.fields.map(fieldDefinition)),
      }),
    [mode.fields],
  );
  const handleStateChange = useCallback(
    (changes: Array<{ path: string; value: unknown }>) => {
      for (const { path, value } of changes) {
        const name = FORM_PATH.exec(path)?.[1];
        if (name) setFieldValue(name, value);
      }
    },
    [setFieldValue],
  );
  if (mode.fields.length === 0) return null;
  return (
    <div data-testid="composer-fields" className="pb-2">
      <JSONUIProvider
        // Remounts when the mode changes or a stopped submission is taken
        // back, so the inputs start from the stored values.
        key={fieldsKey}
        registry={covelRegistry}
        initialState={{ form: fieldValues }}
        handlers={{}}
        directives={covelDirectives}
        onStateChange={handleStateChange}
      >
        <Renderer spec={spec} registry={covelRegistry} />
      </JSONUIProvider>
    </div>
  );
}
