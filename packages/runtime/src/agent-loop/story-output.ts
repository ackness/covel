import { sanitizeStoryNarrativeText } from "../turn-executor/turn-output-helpers.js";

/** Story completion requires player-visible prose, including after hooks. */
export function storyOutputError(output: unknown): string | undefined {
  const narrative =
    output && typeof output === "object" && "narrativeOutput" in output
      ? output.narrativeOutput
      : undefined;
  if (
    typeof narrative !== "string" ||
    !sanitizeStoryNarrativeText(narrative).trim()
  ) {
    return "Story runtime finished without narrative output. Retry the action to generate the missing story.";
  }
  return undefined;
}
