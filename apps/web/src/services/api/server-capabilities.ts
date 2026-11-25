let modelRelay = false;

const modelRelayListeners = new Set<(supported: boolean) => void>();

/**
 * Zero-dependency state module shared by `health.ts` (writer) and
 * `model-relay.ts` (reader), avoiding a circular import chain through
 * `request.ts -> model-settings.ts -> model-relay.ts -> health.ts`.
 */
export function setModelRelaySupported(supported: boolean): void {
  const relayChanged = modelRelay !== supported;
  modelRelay = supported;
  if (relayChanged || supported) {
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
