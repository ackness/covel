/** Execution belongs to a child runtime when a package uses runtimes/. */
const RUNTIME_DECLARATION_FIELDS = [
  "runtimeType",
  "handler",
  "guard",
  "model",
  "stage",
  "trigger",
  "llm",
  "input",
  "output",
  "inputs",
  "effects",
  "after",
  "needs",
  "fallbackFor",
  "execution",
  "turnCompletion",
  "tools",
  "permissions",
  "timeoutMs",
  "maxSteps",
  "maxRetries",
  "callTimeoutMs",
  "firstTokenTimeoutMs",
  "loopDetectionThreshold",
  "requireToolUse",
  "requireExplicitCompletion",
  "completeAfterTools",
  "maxRecursionDepth",
  "advertiseEvents",
  "authorsNote",
  "postHistory",
  "summaryFocus",
] as const;

export function hasRuntimeDeclaration(manifest: object): boolean {
  return RUNTIME_DECLARATION_FIELDS.some((field) =>
    Object.hasOwn(manifest, field),
  );
}

export function multiRuntimeRootDiagnostics(
  frontmatter: object,
): readonly { readonly path: string; readonly message: string }[] {
  return RUNTIME_DECLARATION_FIELDS.filter((field) =>
    Object.hasOwn(frontmatter, field),
  ).map((field) => ({
    path: field,
    message:
      `"${field}" is an execution field and cannot appear in a multi-runtime root PLUGIN.md. ` +
      "Move this declaration to a runtimes/<name>/PLUGIN.md; " +
      "the root's metadata and entry may stay here.",
  }));
}
