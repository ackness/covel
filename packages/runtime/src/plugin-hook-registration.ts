import { HOOK_EVENTS } from "@covel/shared";
import { z } from "zod";

const events: ReadonlySet<string> = new Set(HOOK_EVENTS);
const optionsSchema = z
  .object({
    match: z
      .custom(
        (value) => typeof value === "function",
        "expected a predicate function",
      )
      .optional(),
    timeoutMs: z.number().finite().positive().optional(),
    enforce: z.enum(["pre", "normal", "post"]).optional(),
  })
  .strict();

/** Shared entry validation for production hosts and isolated author tools. */
export function validatePluginHookRegistration(
  event: unknown,
  handler: unknown,
  options: unknown,
  invalid: (message: string) => Error = (message) =>
    new TypeError(`on: ${message}`),
): void {
  const parsed = optionsSchema.safeParse(options === undefined ? {} : options);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "options"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  if (typeof event !== "string" || !events.has(event)) {
    throw invalid(`unknown hook event "${String(event)}"`);
  }
  if (typeof handler !== "function") {
    throw invalid(`hook "${event}" expects a handler function`);
  }
}
