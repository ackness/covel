/**
 * The shape of a story: what a runtime with `outputKind: story` returns.
 *
 * The kernel owns this shape. A story is an ordered list of segments, plus
 * optional stage cues and a yield hint. The kernel renders the segment texts
 * into the derived `narrativeOutput`, so the model never writes the text twice
 * and consumers that read `/narrativeOutput` keep working.
 *
 * The Zod schema is the single source. {@link storyOutputJsonSchema} is the
 * JSON Schema a narrator's output contract file must equal (apart from `$id`
 * and `title`), and the response format a runtime asks for when it declares
 * that contract as its `io.output.schema`. Field descriptions are read by the
 * model, so they ask for names and never for IDs.
 */
import { z } from "zod";
import type {
  StoryOutput,
  StorySegmentKind,
  StoryYield,
} from "@covel/plugin-handlers-utils";

export const STORY_LIMITS = {
  segments: 60,
  speaker: 80,
  text: 4000,
  scene: 200,
  present: 32,
  mood: 80,
} as const;

export const storySegmentKinds = [
  "narration",
  "dialogue",
  "action",
] as const satisfies readonly StorySegmentKind[];
export const storyYields = [
  "user",
  "continue",
] as const satisfies readonly StoryYield[];

export const storySegmentSchema = z.object({
  kind: z
    .enum(storySegmentKinds)
    .describe(
      "narration: scene and description; dialogue: one character's spoken lines; action: what one character does.",
    ),
  speaker: z
    .string()
    .max(STORY_LIMITS.speaker)
    .optional()
    .describe(
      "Who speaks or acts, by the name used in the character profiles. Required for dialogue. Names only, never IDs.",
    ),
  text: z
    .string()
    .min(1)
    .max(STORY_LIMITS.text)
    .describe(
      "Complete prose for this segment, with no blank line inside. Start a new segment when the speaker changes.",
    ),
});

export const storyCuesSchema = z.object({
  scene: z
    .string()
    .max(STORY_LIMITS.scene)
    .optional()
    .describe("Where the scene takes place, in a few words."),
  present: z
    .array(z.string().max(STORY_LIMITS.speaker))
    .max(STORY_LIMITS.present)
    .optional()
    .describe(
      "The characters present in the scene, by name. Names only, never IDs.",
    ),
  mood: z
    .string()
    .max(STORY_LIMITS.mood)
    .optional()
    .describe("The mood of the scene, in a few words."),
});

export const storyOutputSchema = z.looseObject({
  segments: z
    .array(storySegmentSchema)
    .min(1)
    .max(STORY_LIMITS.segments)
    .describe("The story of this reply, in reading order."),
  cues: storyCuesSchema
    .optional()
    .describe(
      "Stage cues for this reply: the scene, who is present, the mood.",
    ),
  yield: z
    .enum(storyYields)
    .optional()
    .describe("Who acts next. Leave it out unless asked; defaults to user."),
});

// Compile-time check: the schema's input matches the SDK's public types.
type SchemaInput = z.input<typeof storyOutputSchema>;
const _shapeMatches: (value: SchemaInput) => StoryOutput = (value) => value;
void _shapeMatches;

/**
 * The JSON Schema of a story. A contract file adds `$id` and `title`; it
 * keeps `additionalProperties: true` so business fields survive.
 */
export function storyOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(storyOutputSchema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  return { ...schema, additionalProperties: true };
}
