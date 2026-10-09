import {
  getProviderProtocolDescriptor,
  type ProviderProtocolOutput,
} from "./provider-protocols.js";

/** Default outputs for an unknown model on a supported wire protocol. */
export function protocolOutputModalities(
  protocol?: string,
): ProviderProtocolOutput[] {
  return [getProviderProtocolDescriptor(protocol)?.output ?? "text"];
}

export function modelOutputTag(output: readonly string[]): string {
  for (const tag of ["evaluation", "image", "speech", "embedding"]) {
    if (output.includes(tag === "speech" ? "audio" : tag)) return tag;
  }
  return "text";
}

/** Framework roles retain their purpose even before a TOML slot exists. */
export function defaultModelRoleTag(slotId: string): string | undefined {
  switch (slotId) {
    case "story":
    case "plugin":
    case "memory":
    case "fast":
    case "balance":
    case "default":
      return "text";
    case "image":
      return slotId;
    case "embed-default":
      return "embedding";
    default:
      return undefined;
  }
}

/** Custom tags remain caller-defined; built-in roles require their modality. */
export function supportsModelRole(
  output: readonly string[],
  tag: string | undefined,
): boolean {
  // Speech and music are two uses of one output; an audio model infers
  // `speech`, and a music role is one a slot is tagged for.
  const modality = tag === "speech" || tag === "music" ? "audio" : tag;
  return !modality ||
    !["text", "image", "audio", "embedding", "evaluation"].includes(modality)
    ? true
    : output.includes(modality);
}
