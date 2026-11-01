import { instructionLocaleFor, type LLMResponseFormat } from "@covel/shared";
import { interpolate, loadPrompt } from "@covel/context";
import { normalizeFinalOutputJsonText } from "../turn-executor/turn-output-helpers.js";
import { schemaAsksForSegments } from "./story-output.js";

// Only fixed parser reasons are forwarded. Native messages may quote the draft.
const syntaxReasons = [
  [/^Unexpected non-whitespace character after JSON$/, "after-root-object"],
  [/^Unexpected end of JSON input$/, "unexpected-end"],
  [/^Unterminated string in JSON$/, "unterminated-string"],
  [/^Bad escaped character in JSON$/, "invalid-escape"],
  [/^Bad Unicode escape in JSON$/, "invalid-unicode-escape"],
  [
    /^Bad control character in string literal in JSON$/,
    "unescaped-control-character",
  ],
  [
    /^Expected (?:double-quoted property name|property name or '}') in JSON$/,
    "expected-property-name",
  ],
  [/^Expected ':' after property name in JSON$/, "expected-colon"],
  [
    /^Expected ',' or '}' after property value in JSON$/,
    "expected-object-separator",
  ],
  [
    /^Expected ',' or ']' after array element in JSON$/,
    "expected-array-separator",
  ],
  [
    /^(?:No number after minus sign|Unterminated fractional number|Exponent part is missing a number) in JSON$/,
    "invalid-number",
  ],
  [/^Unexpected token . in JSON$/, "unexpected-token"],
] as const;

/** Keyed fragments follow the framework action-labels template format. */
async function loadDiagnosticText(locale: string | undefined) {
  const source = await loadPrompt(
    "server",
    "output-format-diagnostics",
    instructionLocaleFor(locale),
  );
  const entries = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([a-z][a-z-]*):[ \t]?(.*)$/.exec(line.trim());
    if (match?.[1] && match[2]?.trim()) entries.set(match[1], match[2].trim());
  }
  return (
    key: string,
    variables: Readonly<Record<string, string | number>> = {},
  ): string => {
    const template = entries.get(key);
    if (!template)
      throw new Error(`output-format-diagnostics: missing "${key}" entry`);
    return interpolate(template, variables);
  };
}

function syntaxProblems(
  error: unknown,
  text: Awaited<ReturnType<typeof loadDiagnosticText>>,
  rootObject: boolean,
): string[] {
  const message = error instanceof SyntaxError ? error.message : "";
  const located = message.match(
    /^(.*?) at position (\d+)(?: \(line (\d+) column (\d+)\))?$/,
  );
  const reason = syntaxReasons.find(([pattern]) =>
    pattern.test(located?.[1] ?? message),
  );
  const reasonKey =
    reason?.[1] === "after-root-object" && !rootObject
      ? "after-root-value"
      : (reason?.[1] ?? "unknown-syntax");
  const problems = [text("syntax", { reason: text(reasonKey) })];
  // Read locations only from a recognized native reason, never from quoted input.
  const offset = located?.[2];
  const line = located?.[3];
  const column = located?.[4];
  if (reason && offset !== undefined) {
    problems.push(
      line !== undefined && column !== undefined
        ? text("location-with-line-column", { offset, line, column })
        : text("location", { offset }),
    );
  }
  return problems;
}

/**
 * Enrich an existing rejection only. JSON.parse diagnoses the original draft;
 * the shared output gate alone decides acceptance, including tolerant salvage.
 */
export async function outputFormatProblems(args: {
  readonly content: string | null;
  readonly responseFormat?: LLMResponseFormat;
  readonly hasToolCalls?: boolean;
  readonly locale?: string;
  readonly problems?: readonly string[];
}): Promise<readonly string[]> {
  const problems = args.problems ?? [];
  const bounded = (items: readonly string[]) =>
    items.slice(0, 5).map((problem) => problem.slice(0, 200));
  if (!args.responseFormat || args.hasToolCalls) return bounded(problems);

  const candidate = normalizeFinalOutputJsonText(args.content ?? "");
  let syntaxError: unknown;
  if (candidate) {
    try {
      JSON.parse(candidate);
      // Valid JSON keeps the gate's field-path and segment diagnostics.
      return bounded(problems);
    } catch (error) {
      syntaxError = error;
    }
  }

  const text = await loadDiagnosticText(args.locale);
  const segments = schemaAsksForSegments(args.responseFormat.schema);
  const complete = text(segments ? "complete-story-object" : "complete-object");
  let diagnostic: readonly string[];
  if (!candidate) {
    diagnostic = [text("empty", { complete })];
  } else if (/^[{["]/.test(candidate)) {
    diagnostic = syntaxProblems(syntaxError, text, candidate.startsWith("{"));
  } else {
    return bounded([text("prose", { complete }), ...problems]);
  }
  // Prose is a misleading downstream symptom for blank or malformed JSON.
  return bounded([
    ...diagnostic,
    ...problems.filter((problem) => !problem.includes("prose")),
  ]);
}
