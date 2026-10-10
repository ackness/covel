/**
 * One reason a form was refused, written for the player. With a `field` (a
 * field `name` of the form) the message is shown under that field; without,
 * it is about the form as a whole.
 */
export interface FormIssue {
  readonly field?: string;
  readonly message: string;
}

/**
 * Pure plugin-owned validation over a committed form and normalized values.
 * The returned text is shown to the player: `context` carries the session's
 * language and the plugin's translations for it, the shape `translate` takes.
 * A plain string is a form-level refusal; `{ field, message }` (or a list of
 * them) places a message under a field.
 */
export type FormValidator = (
  values: Readonly<Record<string, unknown>>,
  data: unknown,
  context: {
    readonly locale: string;
    readonly messages?: import("@covel/shared").PluginMessages;
  },
) => string | FormIssue | readonly FormIssue[] | undefined;

export type ValidatePluginForm = (request: {
  sessionId: string;
  pluginId: string;
  name: string;
  values: Readonly<Record<string, unknown>>;
  data: unknown;
}) => Promise<readonly FormIssue[] | undefined>;

/** Normalize what a validator returned into a list of issues. */
export function normalizeFormRefusal(
  result: unknown,
): readonly FormIssue[] | undefined {
  if (result === undefined || result === null) return undefined;
  const list = Array.isArray(result) ? result : [result];
  const issues: FormIssue[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const { field, message } = item as Record<string, unknown>;
      if (typeof message !== "string") continue;
      issues.push(
        typeof field === "string" && field ? { field, message } : { message },
      );
    } else {
      issues.push({ message: String(item) });
    }
  }
  return issues.length > 0 ? issues : undefined;
}
