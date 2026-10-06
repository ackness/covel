interface ReviewMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content:
    | string
    | readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "image";
            readonly image: {
              readonly id: string;
              readonly mime: string;
              readonly size: number;
            };
          }
      )[];
}
interface ReviewResponse {
  readonly content: string | null;
  readonly toolCalls: readonly { readonly name: string }[];
}

type Person = "first" | "second" | "third";
type SettingsContext = {
  getOwnSettings?: () => Readonly<Record<string, unknown>>;
  sessionId?: string;
  turnId?: string;
  runtimeId?: string;
};
type Request = { pluginId: string; messages: readonly ReviewMessage[] };
type Response<T extends ReviewResponse> = Request & {
  response: T;
  correction?: string;
};

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

const personNames = { first: "一", second: "二", third: "三" } as const;

/**
 * Whether the request reads the Chinese prompt body. Every text this review
 * adds to the request is in the language of that body.
 */
function readsChinese(messages: readonly ReviewMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      /输出要求|叙事规则/.test(m.content),
  );
}

export function perspectiveError(
  text: string,
  person: Person,
  language: "zh" | "en" = "en",
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
  const near = narration.slice(start, start + 65);
  return language === "zh"
    ? `旁白在这里违反了第${personNames[person]}人称视角：${near}。只改旁白；引号里说话者的人称保持不变。`
    : `Narration violates ${person}-person perspective near: ${near}. Fix narration only; keep quoted speakers' pronouns.`;
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
      const zh = readsChinese(payload.messages);
      const player = players.get(keyFor(ctx));
      const playerLine = !player
        ? ""
        : zh
          ? `玩家角色：${JSON.stringify(player)}。`
          : `Player character: ${JSON.stringify(player)}. `;
      const instruction =
        playerLine +
        perspectives[personFor(ctx)][zh ? "zh" : "en"] +
        (zh
          ? " 人物直接对白保留说话者人称。不要复述玩家输入、替玩家添加行动或内心想法。查询工具时只调用工具，不输出准备说明；工具返回后直接写场景，不写核对档案或写作过程。"
          : " Quoted dialogue keeps each speaker's perspective. Do not restate the player's input or add player actions/thoughts. During lookups call tools without preparation chatter; afterward write the scene directly, with no lookup or writing commentary.");
      return {
        action: "continue" as const,
        // Stream normally: a rejected draft or pre-tool text is cleared on the
        // client by the loop's reset signal, and the reviewed final text
        // replaces the streamed text on completion.
        replace: {
          messages: [
            ...payload.messages,
            { role: "system" as const, content: instruction },
          ],
        },
      };
    },
    review<T extends ReviewResponse>(
      ctx: SettingsContext,
      payload: Response<T>,
    ) {
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
      const zh = readsChinese(payload.messages);
      const correction =
        payload.correction ||
        (!text.trim()
          ? zh
            ? "现在用已读取到的事实写出实际的故事正文。不要只调用一个工具就结束。"
            : "Write the actual story now using the retrieved facts. Do not finish with only a tool call."
          : [
              !/<\/?(?:system|system_warning|analysis|thinking|runtime-inputs|available-events)\b/i.test(
                text,
              )
                ? undefined
                : zh
                  ? "只输出游戏内的故事正文。去掉内部指令标签和说明文字。"
                  : "Output only the in-world story. Remove internal instruction tags and commentary.",
              perspectiveError(text, personFor(ctx), zh ? "zh" : "en"),
            ]
              .filter(Boolean)
              .join("\n"));
      return correction
        ? { action: "continue" as const, replace: { correction } }
        : { action: "continue" as const };
    },
  };
}
