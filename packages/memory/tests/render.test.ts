import { describe, it, expect } from 'vitest';
import { renderCoreMemory, renderCompactedSummary } from '../src/render.js';
import type { CoreMemoryBlock } from '../src/types.js';

describe('renderCoreMemory', () => {
  it('should render non-empty blocks as XML-tagged sections', () => {
    const blocks: CoreMemoryBlock[] = [
      { label: 'story_state', content: '主线：苏婉发现灵脉', updatedAt: '' },
      { label: 'scene', content: '坊市西侧巷子', updatedAt: '' },
      { label: 'character_relationships', content: '', updatedAt: '' },
      { label: 'player_profile', content: '练气三层', updatedAt: '' },
    ];

    const result = renderCoreMemory(blocks);

    expect(result).toContain('[核心记忆]');
    expect(result).toContain('<story_state>');
    expect(result).toContain('主线：苏婉发现灵脉');
    expect(result).toContain('</story_state>');
    expect(result).toContain('<scene>');
    expect(result).toContain('<player_profile>');
    // Empty block should be omitted
    expect(result).not.toContain('<character_relationships>');
  });

  it('should return empty string when all blocks are empty', () => {
    const blocks: CoreMemoryBlock[] = [
      { label: 'story_state', content: '', updatedAt: '' },
      { label: 'scene', content: '  ', updatedAt: '' },
    ];

    expect(renderCoreMemory(blocks)).toBe('');
  });

  it('should return empty string for undefined/empty input', () => {
    expect(renderCoreMemory(undefined)).toBe('');
    expect(renderCoreMemory([])).toBe('');
  });

  it('should use English header when locale is en', () => {
    const blocks: CoreMemoryBlock[] = [
      { label: 'scene', content: 'A dark cave', updatedAt: '' },
    ];

    const result = renderCoreMemory(blocks, 'en-US');
    expect(result).toContain('[Core Memory]');
    expect(result).toContain('Current Scene');
  });
});

describe('renderCompactedSummary', () => {
  it('should render summary with Chinese header by default', () => {
    const result = renderCompactedSummary('玩家探索了百灵沼泽...');
    expect(result).toContain('[此前剧情摘要]');
    expect(result).toContain('玩家探索了百灵沼泽');
  });

  it('should use English header for en locale', () => {
    const result = renderCompactedSummary('The party explored...', 'en-US');
    expect(result).toContain('[Previous Story Summary]');
  });

  it('should return empty string for empty summary', () => {
    expect(renderCompactedSummary('')).toBe('');
    expect(renderCompactedSummary('  ')).toBe('');
  });
});
