import { defineDirective, resolvePropValue } from "@json-render/core";
import { standardDirectives } from "@json-render/directives";
import { uiMapDirectiveSchema } from "@covel/shared";

const mapDirective = defineDirective({
  name: "$map",
  description:
    "Look up a value in translatable labels; unknown values use fallback, or the original value.",
  schema: uiMapDirectiveSchema,
  resolve(value, ctx) {
    const parsed = uiMapDirectiveSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { $map, labels, fallback } = parsed.data;
    const key = resolvePropValue($map, ctx);
    if (
      (typeof key === "string" ||
        typeof key === "number" ||
        typeof key === "boolean") &&
      Object.hasOwn(labels, String(key))
    )
      return labels[String(key)];
    return Object.hasOwn(parsed.data, "fallback")
      ? resolvePropValue(fallback, ctx)
      : key;
  },
});

/** Shared by plugin panels, message surfaces and their action parameters. */
export const covelDirectives = [...standardDirectives, mapDirective];
