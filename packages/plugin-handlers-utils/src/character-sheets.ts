import type {
  ExtensionCharacterSchema,
  ExtensionWorldCharacter,
  PromptSegment,
} from "./extension-points.js";
import { modelFacingJson } from "./model-facing.js";
import { pickLocaleText } from "./locale-text.js";
import { characterLabel } from "./character-names.js";

const PROFILES_BUDGET = 8000;
const PROFILE_PART_CAP = 400;

const capped = (text: string) =>
  text.length > PROFILE_PART_CAP
    ? `${text.slice(0, PROFILE_PART_CAP)}...`
    : text;

/** Content between tags must not be able to close its own tag. */
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hasFields = (fields: unknown): fields is Record<string, unknown> =>
  fields !== null &&
  typeof fields === "object" &&
  Object.keys(fields).length > 0;

/**
 * `2/5` for a number attribute whose schema declares min/max (min 0), or
 * `2 (1–5)` when the range starts elsewhere. A bare number tells the model
 * nothing — 2/5 and 2/100 must not read the same.
 */
function withRanges(
  fields: Record<string, unknown>,
  schema: ExtensionCharacterSchema | null | undefined,
): Record<string, unknown> {
  if (!schema) return fields;
  const ranges = new Map(
    schema.attributes
      .filter((a) => a.type === "number" && typeof a.max === "number")
      .map((a) => [a.id, a]),
  );
  if (ranges.size === 0) return fields;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const def = ranges.get(key);
      if (!def || typeof value !== "number") return [key, value];
      const min = def.min ?? 0;
      return [
        key,
        min === 0 ? `${value}/${def.max}` : `${value} (${min}–${def.max})`,
      ];
    }),
  );
}

/**
 * One line per non-player character: `- name [type] | description | fields`,
 * the name followed by `(aka …)` when the character has aliases. Past the
 * budget the rest are listed by name only, to be looked up when needed. No
 * ids: a model looks characters up by name or alias. The format of the
 * `{{ characters.npcs }}` template variable.
 */
function profileLines(
  characters: readonly ExtensionWorldCharacter[],
  locale: string | undefined,
  schema: ExtensionCharacterSchema | null | undefined,
): string {
  const lines: string[] = [];
  const unlisted: string[] = [];
  let used = 0;
  for (const character of characters) {
    if (character.type === "player") continue;
    const parts = [`- ${characterLabel(character)} [${character.type}]`];
    if (character.description) parts.push(capped(character.description));
    if (hasFields(character.fields))
      parts.push(
        capped(
          JSON.stringify(withRanges(modelFacingJson(character.fields), schema)),
        ),
      );
    const line = parts.join(" | ");
    if (unlisted.length > 0 || used + line.length > PROFILES_BUDGET) {
      unlisted.push(character.name);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (unlisted.length > 0)
    lines.push(
      pickLocaleText(
        locale,
        `- （未列出档案：${unlisted.join("、")}）`,
        `- (profiles not shown: ${unlisted.join(", ")})`,
      ),
    );
  return lines.join("\n");
}

/**
 * The characters of the session as a turn-volatile prompt segment: the
 * player's sheet in `<player-character>` and, with `profiles`, one line per
 * non-player character in `<character-profiles>`.
 *
 * A prompt body can interpolate the same data with `{{ player.character }}`
 * and `{{ characters.npcs }}`, but then the system prompt changes whenever a
 * character does, and a provider's prefix cache stops there: every turn, in
 * a session that tracks wounds or conditions. A turn-volatile segment is
 * placed after the history instead, so the body stays as written. Name the
 * blocks in the body, and return this from a `prompt.segment@1` provider:
 *
 * ```js
 * covel.provideExtension("prompt.segment@1", "cast", {
 *   handler: (_input, ctx) =>
 *     characterSheetSegments(ctx.world.characters, {
 *       schema: ctx.world.characterSchema,
 *     }),
 * });
 * ```
 *
 * Returns no segment when the session has no character to show. Pass
 * `ctx.locale` as `locale`: the one sentence this writes (the names of the
 * profiles left out) is then in the language of the prompt body. Pass
 * `ctx.world.characterSchema` as `schema` and a number attribute renders
 * with its range (`"might": "2/5"`); without it the model sees a bare
 * number and cannot tell 2/5 from 2/100.
 */
export function characterSheetSegments(
  characters: readonly ExtensionWorldCharacter[],
  options: {
    readonly profiles?: boolean;
    readonly locale?: string;
    readonly schema?: ExtensionCharacterSchema | null;
  } = {},
): PromptSegment[] {
  const blocks: string[] = [];
  const player = characters.find((character) => character.type === "player");
  if (player) {
    const { id, name, aliases, type, description, fields } = player;
    const projected = modelFacingJson({
      id,
      name,
      ...(aliases?.length ? { aliases } : {}),
      type,
      description,
      fields,
    });
    if (hasFields(projected.fields))
      projected.fields = withRanges(projected.fields, options.schema);
    const sheet = JSON.stringify(projected, null, 2);
    blocks.push(`<player-character>\n${escapeXml(sheet)}\n</player-character>`);
  }
  const profiles = options.profiles
    ? profileLines(characters, options.locale, options.schema)
    : "";
  if (profiles)
    blocks.push(
      `<character-profiles>\n${escapeXml(profiles)}\n</character-profiles>`,
    );
  if (blocks.length === 0) return [];
  return [
    {
      id: "character-sheets",
      content: blocks.join("\n"),
      position: "system",
      audience: "self",
      volatility: "turn",
    },
  ];
}
