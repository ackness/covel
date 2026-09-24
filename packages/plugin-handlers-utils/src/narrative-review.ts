import type { LLMMessage, LLMResponse } from "@covel/shared";

type Person = "first" | "second" | "third";
type SettingsContext = {
  getOwnSettings?: () => Readonly<Record<string, unknown>>;
  sessionId?: string;
  turnId?: string;
  runtimeId?: string;
};
type Request = { pluginId: string; messages: readonly LLMMessage[] };
type Response = Request & { response: LLMResponse; correction?: string };

const perspectives = {
  first: {
    zh: "旁白用玩家角色的第一人称‘我/我的’，不是助手或作者的‘我’。例如：她望着我，雾灯照亮她的袖口。",
    en: "Narrate as the player character in first person (I/me/my), never as the assistant or author. Example: She looks at me; lamplight falls on her sleeve.",
  },
  second: {
    zh: "旁白用玩家角色的第二人称‘你/你的’。例如：她望着你，雾灯照亮她的袖口。",
    en: "Refer to the player character in second person (you/your). Example: She looks at you; lamplight falls on her sleeve.",
  },
  third: {
    zh: "旁白用玩家角色名及第三人称代词，保持玩家角色的有限视角，不称玩家为‘我’或‘你’。",
    en: "Refer to the player by character name and third-person pronouns, from that character's limited viewpoint. Do not address the player as I or you.",
  },
} as const;

function personFor(ctx: SettingsContext): Person {
  const value = ctx.getOwnSettings?.().narrativePerson;
  return value === "first" || value === "third" ? value : "second";
}

/** Inspect narration without changing dialogue or the original story text. */
export function outsideDialogue(text: string): string {
  const pairs: Record<string, string> = {
    "“": "”",
    "‘": "’",
    "「": "」",
    "『": "』",
    "«": "»",
    '"': '"',
    "'": "'",
  };
  const stack: string[] = [];
  let result = "";
  // Outermost unmatched opener: the tail from there is validated as
  // narration, while dialogue that closed properly stays stripped.
  // Returning the raw text instead would un-hide closed dialogue and let
  // its pronouns be flagged as narration (false perspective violations).
  let openStart = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    // Apostrophes in contractions/possessives do not start or end speech.
    const apostrophe =
      char === "'" &&
      /\p{L}/u.test(text[i - 1] ?? "") &&
      /\p{L}/u.test(text[i + 1] ?? "");
    if (!apostrophe && char === stack.at(-1)) {
      stack.pop();
      result += " ";
      if (!stack.length) openStart = -1;
    } else if (
      !apostrophe &&
      pairs[char] &&
      (char !== "'" || !/\p{L}/u.test(text[i - 1] ?? ""))
    ) {
      if (!stack.length) openStart = i;
      stack.push(pairs[char]!);
    } else if (!stack.length) result += char;
  }
  // An unclosed quote cannot hide its remainder from validation.
  return openStart >= 0 ? result + text.slice(openStart) : result;
}

export function perspectiveError(
  text: string,
  person: Person,
): string | undefined {
  const narration = outsideDialogue(text).replace(
    /自我|忘我|无我|你来我往|尔虞我诈|迷你/g,
    "",
  );
  const forbidden =
    person === "first"
      ? /[你妳您]|\b(?:you|your|yours|yourself|yourselves)\b/iu
      : person === "third"
        ? /[我你妳您]|\b(?:I|me|my|mine|myself|we|us|our|ours|you|your|yours)\b/iu
        : /我|\b(?:I|me|my|mine|myself)\b/iu;
  const match = narration.match(forbidden);
  if (!match) return undefined;
  const start = Math.max(0, (match.index ?? 0) - 18);
  return `Narration violates ${person}-person perspective near: ${narration.slice(start, start + 65)}. Fix narration only; keep quoted speakers' pronouns.`;
}

/** Plugin-owned policy using the same public hooks available to community packages. */
export function createNarrativeReview(pluginId: string) {
  const players = new Map<string, string>();
  const keyFor = (ctx: SettingsContext) =>
    `${ctx.sessionId}\0${ctx.turnId}\0${ctx.runtimeId}`;
  return {
    context(
      ctx: SettingsContext,
      payload: {
        pluginId: string;
        characters?: readonly { name: string; type: string }[];
      },
    ) {
      if (payload.pluginId === pluginId) {
        const player = payload.characters?.find(
          (character) => character.type === "player",
        );
        if (player) players.set(keyFor(ctx), player.name);
      }
      return { action: "continue" as const };
    },
    cleanup(ctx: SettingsContext) {
      const prefix = `${ctx.sessionId}\0${ctx.turnId}\0`;
      for (const key of players.keys())
        if (key.startsWith(prefix)) players.delete(key);
      return { action: "continue" as const };
    },
    prepare(ctx: SettingsContext, payload: Request) {
      if (payload.pluginId !== pluginId) return { action: "continue" as const };
      const zh = payload.messages.some(
        (m) =>
          m.role === "system" &&
          typeof m.content === "string" &&
          /输出要求|叙事规则/.test(m.content),
      );
      const player = players.get(keyFor(ctx));
      const instruction =
        (player ? `Player character: ${JSON.stringify(player)}. ` : "") +
        perspectives[personFor(ctx)][zh ? "zh" : "en"] +
        (zh
          ? " 人物直接对白保留说话者人称。不要复述玩家输入、替玩家添加行动或内心想法。查询工具时只调用工具，不输出准备说明；工具返回后直接写场景，不写核对档案或写作过程。"
          : " Quoted dialogue keeps each speaker's perspective. Do not restate the player's input or add player actions/thoughts. During lookups call tools without preparation chatter; afterward write the scene directly, with no lookup or writing commentary.");
      return {
        action: "continue" as const,
        replace: {
          stream: false as const,
          messages: [
            ...payload.messages,
            { role: "system" as const, content: instruction },
          ],
        },
      };
    },
    review(ctx: SettingsContext, payload: Response) {
      if (payload.pluginId !== pluginId) return { action: "continue" as const };
      const response = payload.response;
      // Preparatory prose is not a story and must not seed the final response.
      if (response.toolCalls.some((call) => call.name !== "runtime-done")) {
        return {
          action: "continue" as const,
          replace: { response: { ...response, content: null } },
        };
      }
      const text = response.content ?? "";
      const correction =
        payload.correction ||
        (!text.trim()
          ? "Write the actual story now using the retrieved facts. Do not finish with only a tool call."
          : [
              /<\/?(?:system|system_warning|analysis|thinking|runtime-inputs|available-events)\b/i.test(
                text,
              )
                ? "Output only the in-world story. Remove internal instruction tags and commentary."
                : undefined,
              perspectiveError(text, personFor(ctx)),
            ]
              .filter(Boolean)
              .join("\n"));
      return correction
        ? { action: "continue" as const, replace: { correction } }
        : { action: "continue" as const };
    },
  };
}
