import type {
  createGateway,
  GatewayOptions,
  ResolvedSlotConfig,
} from "@covel/ai-provider";
import { isLoopbackBaseUrl } from "@covel/shared";

/** Check the same origin-gated server configuration used by the execution adapter. */
export function hasServerRuntimeJobCredentials(
  gateway: Pick<ReturnType<typeof createGateway>, "resolveSlot">,
  model: string | undefined,
  envApiKeys: Readonly<Record<string, string>>,
): boolean {
  return hasRuntimeJobCredentials(gateway, model, { envApiKeys });
}

/**
 * Resolve `model` exactly as a gateway adapter built from `options` would —
 * request slot bindings included — and report whether the target carries
 * usable credentials.
 */
export function hasRuntimeJobCredentials(
  gateway: Pick<ReturnType<typeof createGateway>, "resolveSlot">,
  model: string | undefined,
  options: GatewayOptions,
): boolean {
  let slot: ResolvedSlotConfig | null;
  try {
    slot = gateway.resolveSlot(model, options);
  } catch {
    // An incomplete or removed binding is not evidence of usable credentials.
    return false;
  }
  return hasResolvedRuntimeJobCredentials(slot);
}

function hasResolvedRuntimeJobCredentials(
  slot:
    | Pick<ResolvedSlotConfig, "apiKey" | "headers" | "baseUrl">
    | null
    | undefined,
): boolean {
  if (!slot) return false;
  if (slot.apiKey?.trim()) return true;
  // A service on this machine (Ollama, a local gateway) takes no key.
  if (isLoopbackBaseUrl(slot.baseUrl)) return true;
  return Object.entries(slot.headers ?? {}).some(
    ([name, value]) =>
      /^(authorization|api-key|x-api-key)$/i.test(name) &&
      Boolean(value.trim()),
  );
}
