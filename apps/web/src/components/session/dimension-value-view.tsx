import { useTranslation } from "react-i18next";
import {
  isLocaleMapFor,
  type DimensionValueSchema,
  type JsonValue,
} from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";

/**
 * A dimension value as a table, list or text. A world's own record keeps
 * translated text as locale maps; `baseLocale` (the world's language) tells
 * them apart from objects, and `locale` picks the language shown.
 */
export function DimensionValueView({
  schema,
  value,
  locale,
  baseLocale,
}: {
  schema: DimensionValueSchema;
  value: JsonValue;
  locale?: string;
  baseLocale?: string;
}) {
  const { i18n } = useTranslation();
  return (
    <Value
      schema={schema}
      value={value}
      locale={locale ?? i18n.resolvedLanguage ?? i18n.language}
      baseLocale={baseLocale}
    />
  );
}

function Value({
  schema,
  value,
  locale,
  baseLocale,
}: {
  schema: DimensionValueSchema;
  value: JsonValue;
  locale: string;
  baseLocale: string | undefined;
}) {
  const { t } = useTranslation();
  if (baseLocale && isLocaleMapFor(value, baseLocale))
    return (
      <span className="whitespace-pre-wrap wrap-break-word">
        {resolveDisplayText(value, locale)}
      </span>
    );
  if (value === null || typeof value !== "object") {
    const label = schema["x-enumLabels"]?.[String(value)];
    return (
      <span className="whitespace-pre-wrap wrap-break-word">
        {label !== undefined
          ? resolveDisplayText(label, locale)
          : value === null
            ? "—"
            : typeof value === "boolean"
              ? t(value ? "common.yes" : "common.no")
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
                  // per line instead of scrolling. Browsers ignore min-width
                  // on a table cell, so the floor sits on its content.
                  <td key={key} className="p-2 align-top">
                    <div className="min-w-24">
                      <Value
                        schema={rowSchema?.properties?.[key] ?? {}}
                        value={(row as Record<string, JsonValue>)[key] ?? null}
                        locale={locale}
                        baseLocale={baseLocale}
                      />
                    </div>
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
            <Value
              schema={schema.items ?? {}}
              value={item}
              locale={locale}
              baseLocale={baseLocale}
            />
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
              baseLocale={baseLocale}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
