import { describe, it, expect } from "vitest";
import { parseJsonText } from "../src/json-text.js";

const originalError = (text: string): string => {
  try {
    JSON.parse(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("fixture is valid JSON");
};

describe("parseJsonText", () => {
  it("returns valid JSON as it is", () => {
    for (const text of [
      '{"note":"She said \\"no\\".","tags":["",""],"empty":""}',
      '{"a":{"b":[1,2,{"c":"x: y, z"}]}}',
      "[]",
    ])
      expect(parseJsonText(text), text).toEqual(JSON.parse(text));
  });

  it("drops closing brackets after a complete value", () => {
    // The whole argument string of a tool call, closed one level too deep.
    expect(parseJsonText('{"updates":[{"id":"morale","delta":-1}]}]}')).toEqual(
      { updates: [{ id: "morale", delta: -1 }] },
    );
    expect(parseJsonText('{"updates":[]}}\n')).toEqual({ updates: [] });
    // No more than four.
    expect(() => parseJsonText('{"updates":[]}}}}}}')).toThrow();
  });

  it("escapes quote marks that stand inside a string value", () => {
    // The three forms recorded from real runs: quoted speech before more
    // text, quoted speech before the closing punctuation, two quoted words.
    expect(
      parseJsonText(
        '{"entries":[{"category":"character","content":"他断定灯里坐着东西，并认为"灯灭了才好"。本回合他高声喊出灯油用量。"}]}',
      ),
    ).toEqual({
      entries: [
        {
          category: "character",
          content:
            '他断定灯里坐着东西，并认为"灯灭了才好"。本回合他高声喊出灯油用量。',
        },
      ],
    });
    expect(
      parseJsonText(
        '{"facts":[{"name":"沼泽之王","description":"附身村民口中说"心还给我"。"},{"id":"灯心","type":"item"}]}',
      ),
    ).toEqual({
      facts: [
        { name: "沼泽之王", description: '附身村民口中说"心还给我"。' },
        { id: "灯心", type: "item" },
      ],
    });
    expect(
      parseJsonText(
        '{"description": "The page calls the lamp a "lock" and not a "lamp".", "attributes": {"content": "old"}}',
      ),
    ).toEqual({
      description: 'The page calls the lamp a "lock" and not a "lamp".',
      attributes: { content: "old" },
    });
    // The quoted words end the value: the last quote closes the string.
    expect(parseJsonText('{"note": "She said "no""}')).toEqual({
      note: 'She said "no"',
    });
    expect(parseJsonText('["She said "no"", "next"]')).toEqual([
      'She said "no"',
      "next",
    ]);
  });

  it("closes an array element left open where the next one starts", () => {
    // The model closed `attributes` and not the element it belongs to.
    expect(
      parseJsonText(
        '{"events":[{"id":"a","type":"interaction","attributes":{"actor":"mira"}, {"id":"b","type":"movement"}],"statements":[]}',
      ),
    ).toEqual({
      events: [
        { id: "a", type: "interaction", attributes: { actor: "mira" } },
        { id: "b", type: "movement" },
      ],
      statements: [],
    });
    // A model that makes this slip makes it for every element.
    expect(
      parseJsonText(
        '[{"id":"a","tags":["x"], {"id":"b","at":{"x":1},\n {"id":"c","at":{}}, {"id":"d"}, {"id":"e","at":{"y":[1,{"z":2}]}, {"id":"f"}]',
      ),
    ).toEqual([
      { id: "a", tags: ["x"] },
      { id: "b", at: { x: 1 } },
      { id: "c", at: {} },
      { id: "d" },
      { id: "e", at: { y: [1, { z: 2 }] } },
      { id: "f" },
    ]);
  });

  it("settles a closing bracket that does not match the open one", () => {
    // The forms recorded from real runs, in an array sent as text: one `}`
    // too many before the `]`, a `]` inside the last element, and a `}`
    // where the final `]` belongs.
    expect(
      parseJsonText('[{"id":"a","payload":"x"},{"id":"b","payload":"y"}}]\n'),
    ).toEqual([
      { id: "a", payload: "x" },
      { id: "b", payload: "y" },
    ]);
    expect(parseJsonText('[{"id":"a","payload":"says ]"]}]')).toEqual([
      { id: "a", payload: "says ]" },
    ]);
    expect(parseJsonText('[{"id":"a"},{"id":"b","tags":["x"]}}\n')).toEqual([
      { id: "a" },
      { id: "b", tags: ["x"] },
    ]);
    expect(parseJsonText('{"a":[1,2]],"b":3}')).toEqual({ a: [1, 2], b: 3 });
  });

  it("closes the brackets open at the end of text the model ended itself", () => {
    // An array sent as text inside arguments that parsed: the model closed
    // the string after the last element and went on.
    const text = '[{"id":"a","subjectIds":["x"]},{"id":"b","at":{"y":1}}\n';
    expect(parseJsonText(text, { complete: true })).toEqual([
      { id: "a", subjectIds: ["x"] },
      { id: "b", at: { y: 1 } },
    ]);
    expect(
      parseJsonText('[{"id":"a","tags":["x","y"]', { complete: true }),
    ).toEqual([{ id: "a", tags: ["x", "y"] }]);
    // The whole argument string can be output that was cut off.
    expect(() => parseJsonText(text)).toThrow();
    // A value that is not finished stays an error.
    for (const cut of [
      '[{"id":"a"},{"id":',
      '[{"id":"a"},{"id":"b',
      '[{"id":"a"},',
    ])
      expect(() => parseJsonText(cut, { complete: true }), cut).toThrow();
  });

  it("writes the opening of an object once where it is repeated", () => {
    expect(
      parseJsonText(
        '[{"id":"a","attributes":{"topic":"lamp"}},{"{"id":"b","type":"interaction"}]',
      ),
    ).toEqual([
      { id: "a", attributes: { topic: "lamp" } },
      { id: "b", type: "interaction" },
    ]);
    // A string that holds the same characters is not touched.
    const valid = '{"note":"{\\"{\\"id","x":{"{":1}}';
    expect(parseJsonText(valid)).toEqual(JSON.parse(valid));
  });

  it("settles more than one fault in one text", () => {
    expect(
      parseJsonText(
        '{"updates":[{"id":"trust","note":"She calls him "keeper" now."}]}]}',
      ),
    ).toEqual({
      updates: [{ id: "trust", note: 'She calls him "keeper" now.' }],
    });
    expect(
      parseJsonText(
        '[{"id":"a","note":"the "old" lamp","at":{"x":1}, {"id":"b"}]',
      ),
    ).toEqual([{ id: "a", note: 'the "old" lamp', at: { x: 1 } }, { id: "b" }]);
  });

  it("keeps every other fault an error, with the parser's own reason", () => {
    for (const text of [
      // A key is missing, not a brace: the brackets add up for that reading
      // only, so the object is not split in two.
      '[{"name":"Mira","summary":"keeper", {"role":"unknown","place":"hut"}}]',
      // An open object that is not an element of an array.
      '{"a":{"b":1}, {"c":2}}',
      // An array that was not closed.
      '{"events":[{"id":"a"}, "statements":[]}',
      // An open element, and closing brackets that do not add up.
      '[{"id":"a","at":{"x":1}, {"id":"b"}',
      '[{"id":"a","at":{"x":1}, {"id":"b"}]}',
      // The wrong closing bracket in the middle: the array is not closed.
      '{"a":[1,2},"b":3}',
      // A value closed too early is not a bracket too many.
      '{"a":{"b":1}},"c":2}',
      // An opening written twice in an object that lacks a bracket as well.
      '[{"id":"a"},{"{"id":"b","at":{"x":1}]',
      // The output stopped early.
      '{"entries": ',
      '{"entries": [{"content": "The lamp',
      // Text after the value.
      '{"updates":[]} and more',
      // A comma is missing between two strings: not one string with quotes.
      '{"name": "Mira" "role": "keeper"}',
      '["Mira" "Rane"]',
      // A bare quote before a comma or a colon reads as the end of a string.
      '{"note": "She calls it a "lock", not a lamp."}',
      '{"note": "The rule "one lamp": one keeper."}',
      // Quote marks that do not come in pairs: a quote was repeated or lost.
      '{"name": "Mira"", "role": "keeper"}',
      '{"name": ""Mira", "role": "keeper"}',
      '{"note": "a 6" pipe"}',
      // A key is never changed.
      '{"the "old" name": "Mira"}',
      '{"name": "Mira". "role": "keeper"}',
      "{not json",
      "",
    ])
      expect(() => parseJsonText(text), text).toThrow(
        expect.objectContaining({ message: originalError(text) }),
      );
  });
});
