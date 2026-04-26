import { describe, expect, it } from 'vitest';
import {
  isUIRenderPartsInstruction,
  normalizeUIRenderInstruction,
  type UIRenderInstruction,
} from '../src/index.js';

describe('ui render parts', () => {
  it('wraps legacy ui blocks as successful single-part instructions', () => {
    const normalized = normalizeUIRenderInstruction({
      id: 'guide',
      type: 'action-guide',
      topic: 'Next move',
    });

    expect(normalized.status).toBe('success');
    expect(normalized.parts).toEqual([
      {
        id: 'guide',
        type: 'action-guide',
        status: 'success',
        content: { topic: 'Next move' },
      },
    ]);
  });

  it('preserves typed parts and derives aggregate status', () => {
    const instruction: UIRenderInstruction = {
      layout: 'split',
      parts: [
        { id: 'text', type: 'text', status: 'success', content: 'Done' },
        { id: 'image', type: 'image', status: 'pending', content: { prompt: 'forest' } },
      ],
    };

    expect(isUIRenderPartsInstruction(instruction)).toBe(true);
    expect(normalizeUIRenderInstruction(instruction)).toMatchObject({
      layout: 'split',
      status: 'pending',
      parts: instruction.parts,
    });
  });
});
