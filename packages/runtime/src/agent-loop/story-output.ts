/**
 * The kernel's story rules for every `outputKind: story` runtime.
 *
 * - {@link normalizeStoryOutput} (lenient) turns any story-shaped output into
 *   the published story: segments, optional cues, `yield`, and the derived
 *   `narrativeOutput`. Prose becomes one narration segment per paragraph. It
 *   fails only when no text is left.
 * - {@link storyOutputProblems} (strict, model-facing) lists what the repair
 *   request asks the model to fix. Unresolved speaker names are never a
 *   problem here: speakers resolve at commit.
 * - {@link storyOutputError} keeps its meaning: the story has no text.
 */
import {
  STORY_LIMITS,
  storySegmentKinds,
  type StoryCues,
  type StorySegment,
  type StorySegmentKind,
} from "@covel/shared";
import { isMetaChoiceParagraph } from "../turn-executor/turn-output-helpers.js";

export const STORY_EMPTY_ERROR =
  "Story runtime finished without narrative output. Retry the action to generate the missing story.";

const MAX_PROBLEMS = 5;
const MAX_PROBLEM_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isKind = (value: unknown): value is StorySegmentKind =>
  typeof value === "string" &&
  (storySegmentKinds as readonly string[]).includes(value);

/**
 * A segment text as committed: trimmed, with blank lines folded to one
 * newline, so that each segment is exactly one paragraph of the joined text.
 * The live stream applies the same rule (`story-stream.ts`).
 */
export function normalizeSegmentText(text: string): string {
  return text.replace(/\n{2,}/g, "\n").trim();
}

function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, max).join("") : undefined;
}

/** Pieces of at most `max` characters, broken at a newline when one fits. */
function splitLongText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let end = rest.lastIndexOf("\n", max);
    if (end <= 0) {
      end = max;
      // Never cut a surrogate pair in half.
      const code = rest.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    const piece = rest.slice(0, end).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function lenientSegment(value: unknown): StorySegment | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const text = normalizeSegmentText(value.text);
  if (!text) return undefined;
  const kind = isKind(value.kind) ? value.kind : "narration";
  // Narration has no speaker; a dialogue without one stays unattributed.
  const speaker =
    kind === "narration" ? undefined : cut(value.speaker, STORY_LIMITS.speaker);
  return { kind, ...(speaker ? { speaker } : {}), text };
}

/** Keep the story inside the segment limits, dropping text only as a last resort. */
function withinLimits(segments: readonly StorySegment[]): StorySegment[] {
  const split = segments.flatMap((segment) =>
    segment.text.length <= STORY_LIMITS.text
      ? [segment]
      : splitLongText(segment.text, STORY_LIMITS.text).map((text) => ({
          ...segment,
          text,
        })),
  );
  if (split.length <= STORY_LIMITS.segments) return split;
  // Join neighbours of the same kind and speaker until the story fits.
  const merged: StorySegment[] = [];
  for (const segment of split) {
    const last = merged.at(-1);
    if (
      last &&
      last.kind === segment.kind &&
      last.speaker === segment.speaker &&
      last.text.length + 1 + segment.text.length <= STORY_LIMITS.text
    )
      merged[merged.length - 1] = {
        ...last,
        text: `${last.text}\n${segment.text}`,
      };
    else merged.push(segment);
  }
  return merged.slice(0, STORY_LIMITS.segments);
}

function normalizeCues(value: unknown): StoryCues | undefined {
  if (!isRecord(value)) return undefined;
  const scene = cut(value.scene, STORY_LIMITS.scene);
  const mood = cut(value.mood, STORY_LIMITS.mood);
  const present = Array.isArray(value.present)
    ? [
        ...new Set(
          value.present
            .map((name) => cut(name, STORY_LIMITS.speaker))
            .filter((name): name is string => name !== undefined),
        ),
      ].slice(0, STORY_LIMITS.present)
    : [];
  if (!scene && !mood && present.length === 0) return undefined;
  return {
    ...(scene ? { scene } : {}),
    ...(present.length > 0 ? { present } : {}),
    ...(mood ? { mood } : {}),
  };
}

/**
 * The written segments. Without a `segments` array the prose in
 * `narrativeOutput` becomes one narration segment per paragraph.
 */
function rawSegments(output: Record<string, unknown>): StorySegment[] {
  if (Array.isArray(output.segments))
    return output.segments
      .map(lenientSegment)
      .filter((segment): segment is StorySegment => segment !== undefined);
  const prose =
    typeof output.narrativeOutput === "string" ? output.narrativeOutput : "";
  return prose
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((text) => ({ kind: "narration" as const, text }));
}

/**
 * The published story, or undefined when no text is left. Business fields
 * survive; a model-written `narrativeOutput` is replaced by the segment texts
 * joined by blank lines. A prose story's `narrativeOutput` equals
 * `sanitizeStoryNarrativeText` of that prose. Idempotent.
 */
export function normalizeStoryOutput(
  output: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;
  const segments = withinLimits(rawSegments(output));
  // A trailing menu paragraph ("你会怎么做？") is not part of the story.
  let last = segments.at(-1);
  while (last && isMetaChoiceParagraph(last.text)) {
    segments.pop();
    last = segments.at(-1);
  }
  if (segments.length === 0) return undefined;
  const { cues: _cues, yield: _yield, ...rest } = output;
  const cues = normalizeCues(output.cues);
  return {
    ...rest,
    segments,
    ...(cues ? { cues } : {}),
    yield: output.yield === "continue" ? "continue" : "user",
    narrativeOutput: renderStorySegments(segments),
  };
}

/** Display prose shared by committed stories and witnessed-history projections. */
export function renderStorySegments(
  segments: readonly { readonly text: string }[],
): string {
  return segments.map((segment) => segment.text).join("\n\n");
}

/** Story completion requires player-visible text, including after hooks. */
export function storyOutputError(output: unknown): string | undefined {
  return normalizeStoryOutput(output) ? undefined : STORY_EMPTY_ERROR;
}

/** Whether an output schema asks for story segments. */
export function schemaAsksForSegments(
  schema: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const properties = schema?.properties;
  return isRecord(properties) && "segments" in properties;
}

/**
 * What the repair request asks the model to fix: at most five problems, each
 * at most 200 characters, naming segments by position and never by ID.
 */
export function storyOutputProblems(
  output: unknown,
  options: { readonly segmentsRequired: boolean; readonly prose: boolean },
): string[] {
  const problems: string[] = [];
  const segments = isRecord(output) ? output.segments : undefined;
  if (!Array.isArray(segments)) {
    if (options.segmentsRequired)
      problems.push(
        options.prose
          ? "the answer is prose; return a JSON object whose segments array holds the story"
          : "the segments array is missing; put the story in segments",
      );
  } else if (segments.length === 0) {
    problems.push("the segments array is empty; write at least one segment");
  } else {
    if (segments.length > STORY_LIMITS.segments)
      problems.push(
        `there are more than ${STORY_LIMITS.segments} segments; merge some of them`,
      );
    segments.forEach((segment: unknown, index) => {
      const at = `segment ${index + 1}`;
      if (!isRecord(segment)) {
        problems.push(`${at} is not an object with kind and text`);
        return;
      }
      if (!isKind(segment.kind))
        problems.push(
          `${at} has an unknown kind; use narration, dialogue or action`,
        );
      const speaker =
        typeof segment.speaker === "string" ? segment.speaker : undefined;
      if (segment.kind === "dialogue" && !speaker?.trim())
        problems.push(`${at} is dialogue without a speaker; name who speaks`);
      if (speaker && speaker.length > STORY_LIMITS.speaker)
        problems.push(
          `${at} has a speaker name longer than ${STORY_LIMITS.speaker} characters`,
        );
      if (typeof segment.text !== "string" || !segment.text.trim())
        problems.push(`${at} has no text`);
      else if (segment.text.length > STORY_LIMITS.text)
        problems.push(
          `${at} is longer than ${STORY_LIMITS.text} characters; split it`,
        );
    });
  }
  if (problems.length === 0 && !normalizeStoryOutput(output))
    problems.push("the story text is empty");
  return problems
    .slice(0, MAX_PROBLEMS)
    .map((problem) => problem.slice(0, MAX_PROBLEM_LENGTH));
}
