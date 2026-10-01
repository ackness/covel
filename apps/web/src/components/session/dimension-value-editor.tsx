import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { DimensionValueSchema, JsonValue } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";

function valueType(
  schema: DimensionValueSchema,
  value: JsonValue | undefined,
): string {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return (
    types.find((type) => type && type !== "null") ??
    (Array.isArray(value)
      ? "array"
      : value !== null && typeof value === "object"
        ? "object"
        : typeof value)
  );
}

/** Structured controls cover ordinary fields/rows; deeper or localized values use JSON. */
export function supportsDimensionFields(
  schema: DimensionValueSchema,
  value: JsonValue | undefined,
  depth = 0,
): boolean {
  if (schema["x-i18n"] || depth > 3) return false;
  const type = valueType(schema, value);
  if (["string", "number", "integer", "boolean", "null"].includes(type))
    return true;
  if (type === "array")
    return (
      !!schema.items &&
      (Array.isArray(value) && value.length ? value : [undefined]).every(
        (item) => supportsDimensionFields(schema.items!, item, depth + 1),
      )
    );
  if (type !== "object") return false;
  const properties = schema.properties ?? {};
  if (typeof schema.additionalProperties === "object")
    return (
      value && typeof value === "object" && Object.keys(value).length
        ? Object.values(value)
        : [undefined]
    ).every((item) =>
      supportsDimensionFields(
        schema.additionalProperties as DimensionValueSchema,
        item,
        depth + 1,
      ),
    );
  if (Object.keys(properties).length === 0) return false;
  const record: Readonly<Record<string, JsonValue>> =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, JsonValue>>)
      : {};
  return [
    ...new Set([...Object.keys(properties), ...Object.keys(record)]),
  ].every(
    (key) =>
      !!properties[key] &&
      supportsDimensionFields(properties[key]!, record[key], depth + 1),
  );
}

function emptyValue(schema: DimensionValueSchema): JsonValue {
  if (schema.enum?.length) return schema.enum[0]!;
  switch (valueType(schema, undefined)) {
    case "string":
      return "";
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [
          key,
          emptyValue(schema.properties?.[key] ?? {}),
        ]),
      );
    default:
      return null;
  }
}

export function DimensionValueEditor({
  value,
  schema,
  onChange,
  label = "Value",
}: {
  value: JsonValue;
  schema: DimensionValueSchema;
  onChange: (value: JsonValue) => void;
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [newKey, setNewKey] = useState("");
  const type = valueType(schema, value);
  if (
    schema.enum &&
    schema.enum.every((item) => item === null || typeof item !== "object")
  )
    return (
      <label>
        {label}
        <select
          aria-label={label}
          value={schema.enum.findIndex((item) => item === value)}
          onChange={(event) =>
            onChange(schema.enum![Number(event.target.value)]!)
          }
        >
          {schema.enum.map((item, index) => (
            <option key={index} value={index}>
              {resolveDisplayText(
                schema["x-enumLabels"]?.[String(item)] ?? String(item),
                locale,
              )}
            </option>
          ))}
        </select>
      </label>
    );
  if (type === "boolean")
    return (
      <label className="flex items-center gap-2">
        <input
          aria-label={label}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  if (["string", "number", "integer"].includes(type))
    return (
      <label className="block space-y-1 text-xs">
        {label}
        <input
          className="w-full rounded border bg-background p-2"
          aria-label={label}
          type={type === "string" ? "text" : "number"}
          step={type === "integer" ? 1 : "any"}
          value={value === null ? "" : String(value)}
          onChange={(event) =>
            onChange(
              type === "string"
                ? event.target.value
                : event.target.value === ""
                  ? null
                  : Number(event.target.value),
            )
          }
        />
      </label>
    );
  if (type === "array" && Array.isArray(value))
    return (
      <fieldset className="space-y-2">
        <legend>{label}</legend>
        {value.map((item, index) => (
          <div key={index} className="space-y-2 rounded border p-2">
            <DimensionValueEditor
              value={item}
              schema={schema.items ?? {}}
              label={`${label} ${index + 1}`}
              onChange={(next) =>
                onChange(
                  value.map((previous, at) => (at === index ? next : previous)),
                )
              }
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(value.filter((_, at) => at !== index))}
            >
              {t("world.dimensionRemoveRow", "Remove row")} {index + 1}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            schema.maxItems !== undefined && value.length >= schema.maxItems
          }
          onClick={() => onChange([...value, emptyValue(schema.items ?? {})])}
        >
          {t("world.dimensionAddRow", "Add row")}
        </Button>
      </fieldset>
    );
  if (
    type === "object" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const dynamicSchema =
      typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : undefined;
    const keys = [
      ...new Set([
        ...Object.keys(schema.properties ?? {}),
        ...Object.keys(value),
      ]),
    ];
    return (
      <fieldset className="space-y-2">
        <legend>{label}</legend>
        {keys.map((key) => {
          const childSchema = schema.properties?.[key] ?? dynamicSchema ?? {};
          const childLabel = resolveDisplayText(
            childSchema.title ?? key,
            locale,
          );
          return (
            <div key={key} className="space-y-1 rounded border p-2">
              {Object.hasOwn(value, key) ? (
                <DimensionValueEditor
                  value={(value as Readonly<Record<string, JsonValue>>)[key]!}
                  schema={childSchema}
                  label={childLabel}
                  onChange={(next) => onChange({ ...value, [key]: next })}
                />
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({ ...value, [key]: emptyValue(childSchema) })
                  }
                >
                  {t("common.add", "Add")} {childLabel}
                </Button>
              )}
              {!(schema.required ?? []).includes(key) &&
                Object.hasOwn(value, key) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      onChange(
                        Object.fromEntries(
                          Object.entries(value).filter(
                            ([name]) => name !== key,
                          ),
                        ),
                      )
                    }
                  >
                    {t("common.remove", "Remove")} {childLabel}
                  </Button>
                )}
            </div>
          );
        })}
        {dynamicSchema && (
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded border bg-background p-2"
              aria-label={t("world.dimensionRowKey", "New row key")}
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!newKey || Object.hasOwn(value, newKey)}
              onClick={() => {
                onChange({ ...value, [newKey]: emptyValue(dynamicSchema) });
                setNewKey("");
              }}
            >
              {t("world.dimensionAddRow", "Add row")}
            </Button>
          </div>
        )}
      </fieldset>
    );
  }
  return <span>null</span>;
}
