import type { StorySegment } from "@covel/shared";

export const cases = [
  {
    name: "npc-only",
    en: [
      {
        kind: "dialogue",
        speaker: "Mira",
        text: "“Thank you. I’m glad you’re free after school.”",
      },
    ],
    zh: [
      {
        kind: "dialogue",
        speaker: "米拉",
        text: "“谢谢你。很高兴你放学后有空。”",
      },
    ],
  },
  {
    name: "player-dialogue",
    en: [
      {
        kind: "dialogue",
        speaker: "Alex",
        text: "“I agree to meet you after school.”",
      },
    ],
    zh: [
      { kind: "dialogue", speaker: "阿历克斯", text: "“我答应放学后来见你。”" },
    ],
  },
  {
    name: "two-npcs",
    en: [
      { kind: "dialogue", speaker: "Mira", text: "“I will guide you.”" },
      { kind: "dialogue", speaker: "Lin", text: "“I will wait here.”" },
    ],
    zh: [
      { kind: "dialogue", speaker: "米拉", text: "“我带你去。”" },
      { kind: "dialogue", speaker: "林", text: "“我在这里等。”" },
    ],
  },
  {
    name: "action",
    en: [
      {
        kind: "action",
        speaker: "Mira",
        text: "Puts the letter on the table.",
      },
    ],
    zh: [{ kind: "action", speaker: "米拉", text: "把信放在桌上。" }],
  },
  {
    name: "narration",
    en: [{ kind: "narration", text: "A bell rings. Someone leaves." }],
    zh: [{ kind: "narration", text: "铃响了。有人离开。" }],
  },
  {
    name: "alias",
    en: [
      {
        kind: "dialogue",
        speaker: "the Keeper",
        text: "“I promise to show you the library.”",
      },
    ],
    zh: [
      { kind: "dialogue", speaker: "守书人", text: "“我答应带你参观图书馆。”" },
    ],
  },
  {
    name: "quoted-report",
    en: [
      {
        kind: "dialogue",
        speaker: "Mira",
        text: "“Lin said, ‘I will guide you.’ I have not agreed to go.”",
      },
    ],
    zh: [
      {
        kind: "dialogue",
        speaker: "米拉",
        text: "“林说：‘我带你去。’我还没有答应同行。”",
      },
    ],
  },
  {
    name: "unattributed-dialogue",
    en: [{ kind: "dialogue", text: "“I will wait here.”" }],
    zh: [{ kind: "dialogue", text: "“我在这里等。”" }],
  },
] satisfies { name: string; en: StorySegment[]; zh: StorySegment[] }[];
