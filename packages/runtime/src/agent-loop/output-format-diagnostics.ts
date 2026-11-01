import { instructionLocaleFor } from "@covel/shared";
import { interpolate, loadPrompt } from "@covel/context";

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
export async function loadOutputText(locale: string | undefined) {
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
  text: Awaited<ReturnType<typeof loadOutputText>>,
): string[] {
  const message = error instanceof SyntaxError ? error.message : "";
  const located = message.match(
    /^(.*?) at position (\d+)(?: \(line (\d+) column (\d+)\))?$/,
  );
  const reason = syntaxReasons.find(([pattern]) =>
    pattern.test(located?.[1] ?? message),
  );
  const reasonKey = reason?.[1] ?? "unknown-syntax";
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

/** Syntax diagnostics for a complete submission, with no quoted provider text. */
export async function submissionSyntaxProblems(
  error: unknown,
  locale?: string,
): Promise<readonly string[]> {
  return syntaxProblems(error, await loadOutputText(locale));
}
