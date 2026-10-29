import { convertStImport } from "../../src/world-import/st/convert.js";
import { crc32 } from "node:zlib";
import { PNG_SIGNATURE } from "../../src/world-import/st/png-chunks.js";

export function characterBook() {
  return {
    name: "Beacon notes",
    entries: [
      {
        keys: ["beacon"],
        content: "The beacon flashes blue before a storm.",
        name: "Beacon",
        enabled: true,
        insertion_order: 10,
        position: "before_char",
      },
    ],
  };
}
export function v2Card(data: Record<string, unknown> = {}) {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "Mira tends the island beacon.",
      personality: "Patient and curious.",
      scenario: "{{user}} arrives at {{char}}'s beacon.",
      first_mes: "Welcome, {{user}}.",
      mes_example:
        "<START>\n{{user}}: Is the beacon safe?\n{{char}}: As long as the blue light holds.",
      creator_notes:
        "An original sample written for Covel.\n\nDo not narrate these creator notes.",
      tags: ["Island", "Quiet Adventure"],
      creator: "Covel contributors",
      character_book: characterBook(),
      ...data,
    },
  };
}
export function v3Card(data: Record<string, unknown> = {}) {
  const card = v2Card({
    nickname: "Keeper",
    character_version: "1",
    source: ["original"],
    creator_notes_multilingual: { en: "Sample" },
    assets: [],
    ...data,
  });
  return { ...card, spec: "chara_card_v3", spec_version: "3.0" };
}
export function v1Card(data: Record<string, unknown> = {}) {
  return v2Card(data).data;
}
export function worldInfo(
  entries: Record<string, unknown>[] = [
    {
      key: ["harbor"],
      content: "The harbor bell rings at dawn.",
      comment: "Harbor",
      constant: false,
      position: 0,
    },
  ],
) {
  return {
    name: "Island almanac",
    entries: Object.fromEntries(
      entries.map((entry, index) => [String(index), entry]),
    ),
  };
}
export function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([size, payload, checksum]);
}
export function makePng(
  cardJson: unknown,
  keyword: "chara" | "ccv3" = "chara",
  extraChunks: Buffer[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    ...(cardJson === undefined
      ? []
      : [
          pngChunk(
            "tEXt",
            Buffer.from(
              `${keyword}\0${Buffer.from(JSON.stringify(cardJson)).toString("base64")}`,
              "latin1",
            ),
          ),
        ]),
    ...extraChunks,
    pngChunk("IDAT", Buffer.from("789c636000020000050001", "hex")),
    pngChunk("IEND"),
  ]);
}

export async function convert(cards: unknown[], locale = "en-US") {
  return convertStImport({
    files: cards.map((card, index) => ({
      name: `card${index}.json`,
      bytes: Buffer.from(JSON.stringify(card)),
    })),
    locale,
    isIdTaken: async () => false,
  });
}
