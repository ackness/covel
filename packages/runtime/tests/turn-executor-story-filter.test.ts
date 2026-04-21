/**
 * Tests for the story-runtime history filter — detects markdown-fenced and
 * backtick-wrapped JSON that earlier versions let leak into the narrator
 * prompt and caused the LLM to mimic codex/guide JSON in its prose.
 */

import { describe, it, expect } from 'vitest';
import { looksLikeStructuredRuntimeOutput } from '../src/turn-executor.js';

describe('looksLikeStructuredRuntimeOutput', () => {
  it.each([
    ['empty', '', false],
    ['whitespace only', '   \n  ', false],
    ['prose', '你深吸一口气，坊市角落的灵气光点随着呼吸微微颤动。', false],
    ['raw object', '{"narrativeOutput":"x"}', true],
    ['raw array', '[1,2,3]', true],
    ['markdown json', '```json\n{"topic":"x"}\n```', true],
    ['markdown json upper', '```JSON\n{"topic":"x"}\n```', true],
    ['markdown ts', '```ts\n{ foo: 1 }\n```', true],
    ['markdown bare fence', '```\n{"topic":"x"}\n```', true],
    ['backtick-wrapped json', '`{"a":1}`', true],
    ['prose ending in brace', '你赢了}', false],
    ['tool tag', '<tool-call name="x">...</tool-call>', true],
    ['tool tag uppercase', '<TOOL>foo</TOOL>', true],
    ['prose that mentions json', '叙事里提到 JSON 格式的东西', false],
  ])('%s', (_name, input, expected) => {
    expect(looksLikeStructuredRuntimeOutput(input)).toBe(expected);
  });

  it('handles null / undefined defensively', () => {
    expect(looksLikeStructuredRuntimeOutput(undefined)).toBe(false);
    expect(looksLikeStructuredRuntimeOutput(null)).toBe(false);
  });
});
