/**
 * Minimal context shape required for locale resolution.
 * Mirrors the relevant fields of KernelContext without a circular import.
 */
interface LocaleResolutionContext {
  runtimeSettings?: { flat?: Record<string, unknown> };
  world?: unknown;
}

/**
 * Resolve locale with 4-level fallback:
 *   1. Explicit input locale
 *   2. run.defaultLocale from runtimeSettings.flat
 *   3. world.defaultLocale
 *   4. App default ("zh-CN")
 */
export function resolveLocale(
  inputLocale: string | undefined,
  ctx: LocaleResolutionContext,
): string {
  if (inputLocale) return inputLocale;

  // Try run.defaultLocale from runtimeSettings
  const runLocale = ctx.runtimeSettings?.flat?.defaultLocale;
  if (typeof runLocale === "string" && runLocale) return runLocale;

  // Try world.defaultLocale
  if (ctx.world && typeof ctx.world === "object" && "defaultLocale" in ctx.world) {
    const worldLocale = (ctx.world as Record<string, unknown>).defaultLocale;
    if (typeof worldLocale === "string" && worldLocale) return worldLocale;
  }

  return "zh-CN";
}
