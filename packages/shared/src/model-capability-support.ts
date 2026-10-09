import { isBuiltinTextProtocol } from "./provider-protocols.js";

/** Limit model facts to request shapes handled by built-in text adapters. */
export function projectModelCapabilityForBuiltinAdapter<
  T extends {
    input: string[];
    output: string[];
    features?: string[];
  },
>(capability: T, protocol: string | undefined, role: string): T {
  if (role !== "text" || !isBuiltinTextProtocol(protocol)) {
    return capability;
  }

  const input = capability.input.filter(
    (modality) => modality === "text" || modality === "image",
  );
  const output = capability.output.filter((modality) => modality === "text");
  const features = capability.features?.filter(
    (feature) =>
      feature !== "web_search" &&
      feature !== "computer_use" &&
      (feature !== "vision" || input.includes("image")),
  );

  return {
    ...capability,
    input,
    output,
    ...(features ? { features } : {}),
  };
}
