import { useTranslation } from "react-i18next";
import {
  localizeDimensionValue,
  type DimensionValueSchema,
  type JsonValue,
} from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";

export function DimensionValueView({
  schema,
  value,
}: {
  schema: DimensionValueSchema;
  value: JsonValue;
}) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <Value
      schema={schema}
      value={localizeDimensionValue(schema, value, locale)}
      locale={locale}
    />
  );
}

function Value({
  schema,
  value,
  locale,
}: {
  schema: DimensionValueSchema;
  value: JsonValue;
  locale: string;
}) {
  if (value === null || typeof value !== "object") {
    const label = schema["x-enumLabels"]?.[String(value)];
    return (
      <span className="whitespace-pre-wrap wrap-break-word">
        {label !== undefined
          ? resolveDisplayText(label, locale)
          : value === null
            ? "null"
            : String(value)}
      </span>
    );
  }
  const rows = Array.isArray(value)
    ? value.map((row, index) => [String(index), row] as const)
    : schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ? Object.entries(value)
      : null;
  const rowSchema = Array.isArray(value)
    ? schema.items
    : typeof schema.additionalProperties === "object"
      ? schema.additionalProperties
      : undefined;
  const columns = Object.keys(rowSchema?.properties ?? {});
  if (
    rows &&
    columns.length &&
    rows.every(
      ([, row]) =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    )
  )
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2 whitespace-nowrap">ID</th>
              {columns.map((key) => (
                <th className="p-2 whitespace-nowrap" key={key}>
                  {resolveDisplayText(
                    rowSchema?.properties?.[key]?.title ?? key,
                    locale,
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, row]) => (
              <tr key={id} className="border-t">
                <th className="p-2 align-top whitespace-nowrap">{id}</th>
                {columns.map((key) => (
                  // CJK text has a one-character min-content width; without a
                  // floor a narrow panel squeezes prose columns to one glyph
                  // per line instead of scrolling.
                  <td key={key} className="min-w-24 p-2 align-top">
                    <Value
                      schema={rowSchema?.properties?.[key] ?? {}}
                      value={(row as Record<string, JsonValue>)[key] ?? null}
                      locale={locale}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (Array.isArray(value))
    return (
      <ol className="list-inside list-decimal space-y-1">
        {value.map((item, index) => (
          <li key={index}>
            <Value schema={schema.items ?? {}} value={item} locale={locale} />
          </li>
        ))}
      </ol>
    );
  return (
    <dl className="space-y-1 text-sm">
      {Object.entries(value).map(([key, item]) => (
        <div key={key} className="flex flex-wrap gap-2">
          <dt className="font-medium">
            {resolveDisplayText(schema.properties?.[key]?.title ?? key, locale)}
          </dt>
          <dd>
            <Value
              schema={
                schema.properties?.[key] ??
                (typeof schema.additionalProperties === "object"
                  ? schema.additionalProperties
                  : {})
              }
              value={item}
              locale={locale}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
