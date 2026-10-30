/**
 * Story paragraph templates (`contributes.ui.segment`): which template draws
 * each committed segment, and the state it binds to.
 *
 * A template matches a segment when every key of its `match` matches: `kind`
 * names segment kinds, `speaker` names characters by ID or by the name as
 * written. The most specific template wins (kind + speaker, then speaker,
 * then kind); a speaker matched by character ID beats one matched by name;
 * remaining ties go to the session's plugin order, then declaration order.
 */
import {
  segmentTemplateMatchSchema,
  type CharacterVisualModel,
  type SnapshotCharacter,
  type StoryMessageSegment,
} from "@covel/shared";
import type { UISlotEntry, UISlotSpec } from "@/services/api/plugin-data.js";

export interface SegmentTemplate {
  readonly pluginId: string;
  readonly spec: UISlotSpec;
  readonly kinds?: ReadonlySet<string>;
  readonly speakers?: readonly string[];
}

/** The state a segment template binds to with `$state`. */
export interface SegmentTemplateState {
  readonly segment: StoryMessageSegment;
  readonly index: number;
  readonly character?: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
  };
  readonly visual?: CharacterVisualModel;
  readonly [key: string]: unknown;
}

const asList = <T>(value: T | readonly T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as T];

/**
 * The usable templates, in plugin order then declaration order. A spec the
 * server should have rejected (no valid `match`, no view) is skipped.
 */
export function compileSegmentTemplates(
  entries: readonly UISlotEntry[],
): SegmentTemplate[] {
  const templates: SegmentTemplate[] = [];
  for (const entry of entries)
    for (const spec of entry.specs) {
      const match = segmentTemplateMatchSchema.safeParse(spec.match);
      if (!match.success || !spec.view) continue;
      const kinds = asList(match.data.kind);
      const speakers = asList(match.data.speaker).map((name) => name.trim());
      templates.push({
        pluginId: entry.pluginId,
        spec,
        ...(kinds.length ? { kinds: new Set(kinds) } : {}),
        ...(speakers.length ? { speakers } : {}),
      });
    }
  return templates;
}

/** 0 when the template does not match; otherwise higher is more specific. */
function matchRank(
  template: SegmentTemplate,
  segment: StoryMessageSegment,
): number {
  if (template.kinds && !template.kinds.has(segment.kind)) return 0;
  if (!template.speakers) return 1;
  // Narration has no speaker, so it never matches a speaker rule.
  if (segment.kind === "narration") return 0;
  const name = segment.speaker?.trim();
  const byId =
    segment.speakerId !== undefined &&
    template.speakers.includes(segment.speakerId);
  const byName = !byId && !!name && template.speakers.includes(name);
  if (!byId && !byName) return 0;
  return (template.kinds ? 4 : 2) + (byId ? 1 : 0);
}

/** The template that draws `segment`, if any. */
export function selectSegmentTemplate(
  templates: readonly SegmentTemplate[],
  segment: StoryMessageSegment,
): SegmentTemplate | undefined {
  let best: SegmentTemplate | undefined;
  let bestRank = 0;
  for (const template of templates) {
    const rank = matchRank(template, segment);
    // Strictly greater: an earlier template wins a tie.
    if (rank > bestRank) {
      best = template;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * The template of each segment, or undefined when none matches any segment
 * (the message keeps its default rendering).
 */
export function planSegmentTemplates(
  templates: readonly SegmentTemplate[],
  segments: readonly StoryMessageSegment[],
): (SegmentTemplate | undefined)[] | undefined {
  if (templates.length === 0) return undefined;
  const plan = segments.map((segment) =>
    selectSegmentTemplate(templates, segment),
  );
  return plan.some(Boolean) ? plan : undefined;
}

/**
 * What a template reads: the committed segment, its position, and the
 * resolved speaker's public character fields and visual when the host has
 * them. No plugin data, settings or other IDs.
 */
export function segmentTemplateState(
  segment: StoryMessageSegment,
  index: number,
  characters: readonly SnapshotCharacter[],
  visuals: ReadonlyMap<string, CharacterVisualModel>,
): SegmentTemplateState {
  const character = segment.speakerId
    ? characters.find((entry) => entry.id === segment.speakerId)
    : undefined;
  const visual = character ? visuals.get(character.id) : undefined;
  return {
    segment: {
      kind: segment.kind,
      text: segment.text,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
    },
    index,
    ...(character
      ? {
          character: {
            id: character.id,
            name: character.name,
            type: character.type,
          },
        }
      : {}),
    ...(visual ? { visual } : {}),
  };
}
