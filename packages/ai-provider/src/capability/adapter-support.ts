import { projectModelCapabilityForBuiltinAdapter } from "@covel/shared";
import type { ModelCapability, ProviderProtocol } from "../types.js";

/**
 * Project model facts onto the request shapes implemented by built-in text
 * adapters. Other roles use their own wires, so their modalities remain intact.
 * Callers with a programmatic adapter must retain the original capability.
 */
export function projectCapabilityForBuiltinAdapter(
  capability: ModelCapability,
  protocol: ProviderProtocol | undefined,
  role: string,
): ModelCapability {
  return projectModelCapabilityForBuiltinAdapter(capability, protocol, role);
}
