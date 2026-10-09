import type { LLMDiagnostics, LLMProviderWarning } from "@covel/shared";

export function withProviderWarnings<
  T extends { diagnostics?: LLMDiagnostics },
>(result: T, warnings: readonly LLMProviderWarning[]): T {
  if (!warnings.length) return result;
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      warnings: [...warnings, ...(result.diagnostics?.warnings ?? [])],
    },
  };
}
