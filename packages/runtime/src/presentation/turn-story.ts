/**
 * Which story speaks for a turn. Commit (and the auto-advance decision it
 * returns), inline presentation and deferred presentation all decide it here,
 * so they cannot disagree about one execution.
 */
import { STORY_OUTPUT_CONTRACT, type RuntimeManifest } from "@covel/shared";
import { isPublicStoryRuntime } from "@covel/shared/contracts";

type StoryRuntime = Pick<
  RuntimeManifest,
  "outputKind" | "concealed" | "subagentOnly" | "outputContract"
>;

/**
 * The stories that speak for a turn, among the public stories its execution
 * told at top level (a nested call's story belongs to its caller, so callers
 * leave nested ones out). The automatically scheduled story runtime, the
 * story-contract provider, speaks for the turn whenever it told a story: a
 * hand-run or event story told beside it never displaces it. When it told
 * none, every candidate does. A reader that needs the turn's story takes it
 * only when exactly one remains (see {@link turnStory}).
 */
export function turnStoryCandidates<T>(
  candidates: Iterable<T>,
  runtimeOf: (candidate: T) => StoryRuntime | undefined,
): T[] {
  const stories = [...candidates].filter((candidate) => {
    const runtime = runtimeOf(candidate);
    return (
      runtime !== undefined &&
      isPublicStoryRuntime(runtime) &&
      runtime.subagentOnly !== true
    );
  });
  const provided = stories.filter(
    (candidate) =>
      runtimeOf(candidate)?.outputContract === STORY_OUTPUT_CONTRACT,
  );
  return provided.length > 0 ? provided : stories;
}

/** The turn's one story, or `undefined` when it told none or several. */
export function turnStory<T>(
  candidates: Iterable<T>,
  runtimeOf: (candidate: T) => StoryRuntime | undefined,
): T | undefined {
  const stories = turnStoryCandidates(candidates, runtimeOf);
  return stories.length === 1 ? stories[0] : undefined;
}
