import type { createGateway, ResolvedSlotConfig } from "@covel/ai-provider";

/** Check the same origin-gated server configuration used by the execution adapter. */
export function hasServerRuntimeJobCredentials(
  gateway: Pick<ReturnType<typeof createGateway>, "resolveSlot">,
  model: string | undefined,
  envApiKeys: Readonly<Record<string, string>>,
): boolean {
  let slot: ResolvedSlotConfig | null;
  try {
    slot = gateway.resolveSlot(model, { envApiKeys });
  } catch {
    // An incomplete or removed binding is not evidence of usable credentials.
    return false;
  }
  return hasResolvedRuntimeJobCredentials(slot);
}

export function hasResolvedRuntimeJobCredentials(
  slot: Pick<ResolvedSlotConfig, "apiKey" | "headers"> | null | undefined,
): boolean {
  if (!slot) return false;
  if (slot.apiKey?.trim()) return true;
  return Object.entries(slot.headers ?? {}).some(
    ([name, value]) =>
      /^(authorization|api-key|x-api-key)$/i.test(name) &&
      Boolean(value.trim()),
  );
}
