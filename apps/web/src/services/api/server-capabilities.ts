import type {
  CapabilityCeiling,
  CapabilityKey,
} from "@covel/shared/permissions";

/**
 * A shared server that keeps players' saves in their own browsers: the
 * browser-private form, or a hosted tier on the memory store. Its players see
 * a notice about where their data and keys go.
 */
export interface SharedServerInfo {
  /** The public source repository, an https address. */
  readonly repository?: string;
  /** The commit the running build was made from. */
  readonly commit?: string;
}

let operatorTokenRequired: boolean | undefined;
let sharedServer: SharedServerInfo | null = null;
let modelRelay = false;
let deploymentCapabilities: Partial<
  Record<CapabilityKey, CapabilityCeiling>
> | null = null;

const modelRelayListeners = new Set<(supported: boolean) => void>();

/**
 * Zero-dependency state module shared by `health.ts` (writer) and
 * `model-relay.ts` / settings panes (readers), avoiding a circular import
 * chain through `request.ts -> model-settings.ts -> model-relay.ts -> health.ts`.
 */
export function updateServerCapabilities(next: {
  readonly operatorTokenRequired?: boolean;
  readonly sharedServer: SharedServerInfo | null;
  readonly modelRelay: boolean;
  readonly deploymentCapabilities: Partial<
    Record<CapabilityKey, CapabilityCeiling>
  > | null;
}): void {
  if (typeof next.operatorTokenRequired === "boolean") {
    operatorTokenRequired = next.operatorTokenRequired;
  }
  sharedServer = next.sharedServer;
  const relayChanged = modelRelay !== next.modelRelay;
  modelRelay = next.modelRelay;
  deploymentCapabilities = next.deploymentCapabilities;
  if (relayChanged || next.modelRelay) {
    for (const listener of modelRelayListeners) {
      listener(modelRelay);
    }
  }
}

export function onModelRelaySupportedChange(
  listener: (supported: boolean) => void,
): () => void {
  modelRelayListeners.add(listener);
  return () => {
    modelRelayListeners.delete(listener);
  };
}

/**
 * True when the server reaches models on the player's computer or local
 * network through this browser (the local model relay).
 */
export function isModelRelaySupported(): boolean {
  return modelRelay;
}

/**
 * Null until a server has answered, and on a server whose saves are not kept
 * in the player's browser.
 */
export function getSharedServerInfo(): SharedServerInfo | null {
  return sharedServer;
}

/**
 * What the last health reply said about the operator token. Undefined until
 * a server has answered; a caller that hides the token entry on `false` must
 * keep it on `undefined`, or a hosted operator has no place to enter it.
 */
export function isOperatorTokenRequired(): boolean | undefined {
  return operatorTokenRequired;
}

/**
 * L1 deployment ceiling reported by `/api/health`, or `undefined` when the
 * server has not answered or did not advertise this capability.
 */
export function getDeploymentCapabilityCeiling(
  key: CapabilityKey,
): CapabilityCeiling | undefined {
  return deploymentCapabilities?.[key];
}

/**
 * True only when the server explicitly reported `key` as `"disabled"` at L1.
 */
export function isDeploymentCapabilityDisabled(key: CapabilityKey): boolean {
  return deploymentCapabilities?.[key] === "disabled";
}
