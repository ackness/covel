import { describe, expect, it } from 'vitest';
import { applyBranchReplyAcceptedCandidates } from '../src/branch-reply-history.js';

const baseHistory = [
  {
    id: 'm1',
    role: 'user',
    content: 'Open the door.',
    turnId: 'turn-1',
    sourceType: 'player',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'The old story text.',
    turnId: 'turn-1',
    sourceType: 'runtime',
    sourceRuntimeId: 'chat-mode-narrator',
  },
  {
    id: 'm3',
    role: 'user',
    content: 'Keep going.',
    turnId: 'turn-2',
    sourceType: 'player',
  },
] as const;

describe('applyBranchReplyAcceptedCandidates', () => {
  it('replaces the matching assistant message with acceptedText', () => {
    const projected = applyBranchReplyAcceptedCandidates(baseHistory, [
      {
        key: 'turn-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        value: {
          schemaVersion: 1,
          turnId: 'turn-1',
          status: 'accepted',
          acceptedCandidateId: 'turn-1-candidate-2',
          acceptedText: 'The accepted branch text.',
          candidates: [
            { id: 'turn-1-candidate-2', text: 'The accepted branch text.' },
          ],
        },
      },
    ]);

    expect(projected.map((message) => message.content)).toEqual([
      'Open the door.',
      'The accepted branch text.',
      'Keep going.',
    ]);
    expect(baseHistory[1].content).toBe('The old story text.');
  });

  it('falls back to the accepted candidate text when acceptedText is absent', () => {
    const projected = applyBranchReplyAcceptedCandidates(baseHistory, [
      {
        key: 'turn-1',
        value: {
          turnId: 'turn-1',
          status: 'accepted',
          acceptedCandidateId: 'turn-1-candidate-3',
          candidates: [
            { id: 'turn-1-candidate-3', text: 'Candidate text fallback.' },
          ],
        },
      },
    ]);

    expect(projected[1]?.content).toBe('Candidate text fallback.');
  });

  it('keeps history unchanged for ready or malformed branch records', () => {
    const projected = applyBranchReplyAcceptedCandidates(baseHistory, [
      {
        key: 'turn-1',
        value: {
          turnId: 'turn-1',
          status: 'ready',
          selectedCandidateId: 'turn-1-candidate-1',
          candidates: [{ id: 'turn-1-candidate-1', text: 'Draft only.' }],
        },
      },
    ]);

    expect(projected).toBe(baseHistory);
  });

  it('honors runtimeId when branch state targets a specific runtime', () => {
    const history = [
      ...baseHistory,
      {
        id: 'm4',
        role: 'assistant',
        content: 'Other runtime text.',
        turnId: 'turn-1',
        sourceType: 'runtime',
        sourceRuntimeId: 'side-narrator',
      },
    ] as const;

    const projected = applyBranchReplyAcceptedCandidates(history, [
      {
        key: 'turn-1',
        value: {
          turnId: 'turn-1',
          runtimeId: 'chat-mode-narrator',
          status: 'accepted',
          acceptedText: 'Narrator-only branch.',
        },
      },
    ]);

    expect(projected[1]?.content).toBe('Narrator-only branch.');
    expect(projected[3]?.content).toBe('Other runtime text.');
  });
});
