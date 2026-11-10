/** Dependency-free identities shared by authoring schemas, hosts and activation. */
export const kernelExtensionPoints = {
  historyCompact: { id: "history.compact@2", mode: "single" },
  mediaImageFlow: { id: "media.image-flow@1", mode: "single" },
  promptHistoryTransform: {
    id: "prompt.history-transform@1",
    mode: "pipeline",
  },
  promptSegment: { id: "prompt.segment@1", mode: "collect" },
  sessionWorldContext: { id: "session.world-context@1", mode: "single" },
  uiSlot: { id: "ui.slot@1", mode: "pipeline" },
} as const;

/**
 * The story output contract. The kernel owns the story shape for every
 * `outputKind: story` runtime, so this is the one plugin-facing contract the
 * framework names itself rather than discovering it: presentation runtimes may
 * bind it only as optional public input and may never provide or require it,
 * and commit and presentation projection recognize the public story by it.
 * Bump the version here, together with every provider and consumer, when the
 * story shape breaks.
 */
export const STORY_OUTPUT_CONTRACT = "narrative-engine@2";

export const kernelUiSlots = {
  backdrop: "stage.backdrop@1",
  cast: "stage.cast@1",
  choices: "stage.choices@1",
  characterVisual: "character.visual@1",
  summary: "session.summary@1",
  music: "stage.music@1",
} as const;

const kernelContracts = new Set<string>([
  ...Object.values(kernelExtensionPoints).map((point) => point.id),
  ...Object.values(kernelUiSlots),
]);
export function isKernelExtensionContract(contract: string): boolean {
  return kernelContracts.has(contract);
}
export const INVALID_KERNEL_CONFLICT = "invalid-conflict";
export function kernelConflictMessage(contract: string): string {
  return `conflicts cannot target kernel extension contract ${contract}; composition is controlled by the extension point mode`;
}
