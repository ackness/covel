import { describe, expect, it } from "vitest";
import {
  extractCardJson,
  readPngTextChunks,
  stripPngTextChunks,
  MAX_CARD_JSON_BYTES,
} from "../../src/world-import/st/png-chunks.js";
import {
  makePng,
  pngChunk,
  v2Card,
  v3Card,
} from "../helpers/st-card-fixtures.js";
import { StImportError } from "../../src/world-import/st/report.js";
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StImportError);
    expect(error).toMatchObject({ code });
  }
}
describe("PNG card chunks", () => {
  it.each(["chara", "ccv3"] as const)("reads %s", (keyword) => {
    const card = v2Card();
    expect(readPngTextChunks(makePng(card, keyword))[0]?.keyword).toBe(keyword);
    expect(extractCardJson(makePng(card, keyword)).json).toEqual(card);
  });
  it("prefers ccv3", () => {
    const extra = pngChunk(
      "tEXt",
      Buffer.from(
        `ccv3\0${Buffer.from(JSON.stringify(v3Card())).toString("base64")}`,
      ),
    );
    expect(extractCardJson(makePng(v2Card(), "chara", [extra])).json).toEqual(
      v3Card(),
    );
  });
  it("rejects a bad signature", () =>
    expectCode(() => readPngTextChunks(new Uint8Array(20)), "png-invalid"));
  it("bounds lengths including truncated CRC", () => {
    const png = makePng(v2Card());
    png.writeUInt32BE(0xffffffff, 8);
    expectCode(() => extractCardJson(png), "png-invalid");
    expectCode(
      () => extractCardJson(makePng(v2Card()).subarray(0, -2)),
      "png-invalid",
    );
  });
  it("tolerates missing IEND only after a card", () => {
    expect(extractCardJson(makePng(v2Card()).subarray(0, -12)).spec).toBe(
      "chara",
    );
    expectCode(
      () => readPngTextChunks(makePng(undefined).subarray(0, -12)),
      "png-invalid",
    );
  });
  it("reports missing card and compressed text", () => {
    expectCode(() => extractCardJson(makePng(undefined)), "png-no-card");
    expectCode(
      () =>
        extractCardJson(
          makePng(undefined, "chara", [
            pngChunk("zTXt", Buffer.from("chara\0x")),
          ]),
        ),
      "png-unsupported-text-chunk",
    );
  });
  it.each([
    ["???", "png-base64-invalid"],
    ["abc=def=", "png-base64-invalid"],
    [Buffer.from([0xff]).toString("base64"), "png-utf8-invalid"],
    [Buffer.from("not json").toString("base64"), "json-invalid"],
  ])("rejects invalid payload %s", (payload, code) => {
    expectCode(
      () =>
        extractCardJson(
          makePng(undefined, "chara", [
            pngChunk("tEXt", Buffer.from(`chara\0${payload}`)),
          ]),
        ),
      code,
    );
  });
  it("caps decoded payload before allocation", () =>
    expectCode(
      () => extractCardJson(makePng("x".repeat(MAX_CARD_JSON_BYTES))),
      "json-too-large",
    ));
  it("handles a near-limit payload without regex stack overflow", () =>
    expect(
      extractCardJson(makePng("x".repeat(MAX_CARD_JSON_BYTES - 10))).json,
    ).toHaveLength(MAX_CARD_JSON_BYTES - 10));
  it("caps chunk count", () =>
    expectCode(
      () =>
        readPngTextChunks(
          makePng(
            v2Card(),
            "chara",
            Array.from({ length: 4096 }, () => pngChunk("tIME")),
          ),
        ),
      "png-chunks-limit",
    ));
  it("strips all metadata and preserves image chunks", () => {
    const result = stripPngTextChunks(
      makePng(
        v2Card(),
        "chara",
        ["zTXt", "iTXt", "eXIf", "tIME"].map((type) => pngChunk(type)),
      ),
    );
    expect(readPngTextChunks(result)).toEqual([]);
    const buffer = Buffer.from(result);
    for (const type of ["IHDR", "IDAT", "IEND"])
      expect(buffer.includes(Buffer.from(type))).toBe(true);
    for (const type of ["tEXt", "zTXt", "iTXt", "eXIf", "tIME"])
      expect(buffer.includes(Buffer.from(type))).toBe(false);
  });
});
