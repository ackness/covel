import type { ContextProvider, ContextProviderInput } from "@covel/plugin-runtime";

/**
 * Narrative context section returned to downstream runtimes.
 * Provides a summary of the narrator's latest output plus style guidance.
 */
export interface NarratorContextSection {
  readonly title: string;
  readonly content: string;
  readonly priority: number;
}

/**
 * Shape of narrator-related state stored via state.patch proposals.
 */
interface NarratorState {
  readonly lastNarrative?: string;
  readonly tone?: string;
}

/**
 * Extract narrator state from the raw plugin state object.
 * Returns undefined if no narrator state exists.
 */
function extractNarratorState(
  state: unknown
): NarratorState | undefined {
  if (
    state === null ||
    state === undefined ||
    typeof state !== "object"
  ) {
    return undefined;
  }

  const record = state as Record<string, unknown>;
  const narratorState = record.narratorState;

  if (
    narratorState === null ||
    narratorState === undefined ||
    typeof narratorState !== "object"
  ) {
    return undefined;
  }

  return narratorState as NarratorState;
}

/**
 * Format the narrator context section content from state and world info.
 */
export function formatNarratorContext(
  narratorState: NarratorState | undefined,
  world: unknown,
  locale: string
): string {
  const isZh = locale.startsWith("zh");
  const lines: readonly string[] = buildContextLines(narratorState, world, isZh);

  return lines.join("\n");
}

function buildContextLines(
  narratorState: NarratorState | undefined,
  world: unknown,
  isZh: boolean
): readonly string[] {
  const lines: string[] = [];

  // Add tone/style guidance from world setting
  const worldRecord = (typeof world === "object" && world !== null)
    ? world as Record<string, unknown>
    : undefined;
  const worldDescription = worldRecord?.description;

  if (typeof worldDescription === "string" && worldDescription.trim()) {
    const header = isZh ? "世界氛围" : "World Atmosphere";
    lines.push(`[${header}]`);
    lines.push(worldDescription.trim());
    lines.push("");
  }

  // Add tone from narrator state
  const tone = narratorState?.tone;
  if (typeof tone === "string" && tone.trim()) {
    const header = isZh ? "叙事基调" : "Narrative Tone";
    lines.push(`[${header}]`);
    lines.push(tone.trim());
    lines.push("");
  }

  // Add last narrative summary for downstream runtimes
  const lastNarrative = narratorState?.lastNarrative;
  if (typeof lastNarrative === "string" && lastNarrative.trim()) {
    const header = isZh ? "最新叙事摘要" : "Latest Narrative Summary";
    lines.push(`[${header}]`);
    lines.push(lastNarrative.trim());
  }

  return lines;
}

/**
 * Context provider that injects narrator guidance and last output summary
 * into the context for downstream runtimes (e.g., guide, tracker).
 */
export const narratorContextProvider: ContextProvider = async (
  input: ContextProviderInput
): Promise<NarratorContextSection | null> => {
  const narratorState = extractNarratorState(input.state);
  const content = formatNarratorContext(narratorState, input.world, input.locale);

  if (!content.trim()) {
    return null;
  }

  return {
    title: "Narrator Context",
    content,
    priority: 70,
  };
};
