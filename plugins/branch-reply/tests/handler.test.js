import { describe, expect, it } from 'vitest';
import { getPendingProposals } from '@covel/tools';
import handler from '../handler.js';

function ctx(manualPayload, store = {}) {
  return {
    sessionId: 'sess-branch',
    turnId: 'turn-branch',
    pluginId: 'branch-reply',
    runtimeId: 'branch-reply',
    playerMessage: 'I ask the guard to explain the sealed door.',
    store,
    completedResults: new Map(),
    config: {},
    manualPayload,
  };
}

describe('branch-reply handler', () => {
  it('creates deterministic candidates and stores turn plus message state', async () => {
    const result = await handler(ctx({
      action: 'createCandidates',
      turnId: 'turn-42',
      baseText: 'I test the lock with the brass key.',
      count: 3,
    }));

    expect(result).toMatchObject({
      action: 'createCandidates',
      turnId: 'turn-42',
      candidateCount: 3,
      selectedCandidateId: 'turn-42-candidate-1',
    });

    const [proposal] = getPendingProposals(result);
    expect(proposal).toMatchObject({
      type: 'plugin.data.batch',
      source: { pluginId: 'branch-reply', runtimeId: 'branch-reply' },
      payload: {
        items: [
          {
            namespace: 'turns',
            key: 'turn-42',
            value: {
              schemaVersion: 1,
              turnId: 'turn-42',
              status: 'ready',
              selectedCandidateId: 'turn-42-candidate-1',
              candidates: [
                {
                  id: 'turn-42-candidate-1',
                  index: 0,
                  text: 'I test the lock with the brass key.',
                  source: 'deterministic',
                },
                {
                  id: 'turn-42-candidate-2',
                  index: 1,
                  text: 'I test the lock with the brass key. I watch for the first honest reaction.',
                  source: 'deterministic',
                },
                {
                  id: 'turn-42-candidate-3',
                  index: 2,
                  text: 'I test the lock with the brass key. Then I wait before choosing my next move.',
                  source: 'deterministic',
                },
              ],
            },
          },
          {
            namespace: 'message',
            key: 'turn-42',
            value: {
              __turnId: 'turn-42',
              schemaVersion: 1,
              turnId: 'turn-42',
              status: 'ready',
              selectedCandidateId: 'turn-42-candidate-1',
              candidateCount: 3,
            },
          },
        ],
      },
    });
  });

  it('accepts a stored candidate and updates both records', async () => {
    const storedTurn = {
      schemaVersion: 1,
      turnId: 'turn-42',
      baseText: 'I test the lock.',
      candidates: [
        { id: 'turn-42-candidate-1', index: 0, text: 'I test the lock.', source: 'deterministic' },
        { id: 'turn-42-candidate-2', index: 1, text: 'I test the lock. I listen.', source: 'deterministic' },
      ],
      selectedCandidateId: 'turn-42-candidate-1',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = {
      async getPluginData(sessionId, pluginId, namespace, key) {
        expect([sessionId, pluginId, namespace, key]).toEqual([
          'sess-branch',
          'branch-reply',
          'turns',
          'turn-42',
        ]);
        return { value: storedTurn };
      },
    };

    const result = await handler(ctx({
      action: 'acceptCandidate',
      turnId: 'turn-42',
      candidateId: 'turn-42-candidate-2',
    }, store));

    expect(result).toMatchObject({
      action: 'acceptCandidate',
      turnId: 'turn-42',
      acceptedCandidateId: 'turn-42-candidate-2',
      acceptedText: 'I test the lock. I listen.',
    });

    const [proposal] = getPendingProposals(result);
    const items = proposal.payload.items;
    expect(items[0]).toMatchObject({
      namespace: 'turns',
      key: 'turn-42',
      value: {
        status: 'accepted',
        selectedCandidateId: 'turn-42-candidate-2',
        acceptedCandidateId: 'turn-42-candidate-2',
        acceptedText: 'I test the lock. I listen.',
      },
    });
    expect(items[1]).toMatchObject({
      namespace: 'message',
      key: 'turn-42',
      value: {
        __turnId: 'turn-42',
        status: 'accepted',
        selectedCandidateId: 'turn-42-candidate-2',
        acceptedCandidateId: 'turn-42-candidate-2',
      },
    });
  });

  it('accepts a stored candidate through a scoped function store view', async () => {
    const storedTurn = {
      schemaVersion: 1,
      turnId: 'turn-42',
      baseText: 'I test the lock.',
      candidates: [
        { id: 'turn-42-candidate-1', index: 0, text: 'I test the lock.', source: 'deterministic' },
        { id: 'turn-42-candidate-2', index: 1, text: 'I test the lock. I listen.', source: 'deterministic' },
      ],
      selectedCandidateId: 'turn-42-candidate-1',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = {
      async getPluginData(namespace, key) {
        expect([namespace, key]).toEqual(['turns', 'turn-42']);
        return { value: storedTurn };
      },
    };

    const result = await handler(ctx({
      action: 'acceptCandidate',
      turnId: 'turn-42',
      candidateId: 'turn-42-candidate-2',
    }, store));

    expect(result).toMatchObject({
      action: 'acceptCandidate',
      acceptedCandidateId: 'turn-42-candidate-2',
      acceptedText: 'I test the lock. I listen.',
    });
  });

  it('requires selectedCandidateId to reference a generated candidate', async () => {
    await expect(handler(ctx({
      action: 'createCandidates',
      turnId: 'turn-42',
      count: 2,
      selectedCandidateId: 'missing-candidate',
    }))).rejects.toThrow('manualPayload.selectedCandidateId must reference an existing candidate');
  });

  it('rejects acceptCandidate when the turn record is missing', async () => {
    const store = {
      async getPluginData() {
        return null;
      },
    };

    await expect(handler(ctx({
      action: 'acceptCandidate',
      turnId: 'turn-42',
      candidateId: 'turn-42-candidate-1',
    }, store))).rejects.toThrow('branch-reply turn record was not found');
  });

  it('rejects acceptCandidate when candidateId is not in the stored turn record', async () => {
    const store = {
      async getPluginData() {
        return {
          value: {
            schemaVersion: 1,
            turnId: 'turn-42',
            baseText: 'I test the lock.',
            candidates: [
              { id: 'turn-42-candidate-1', index: 0, text: 'I test the lock.', source: 'deterministic' },
            ],
            selectedCandidateId: 'turn-42-candidate-1',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        };
      },
    };

    await expect(handler(ctx({
      action: 'acceptCandidate',
      turnId: 'turn-42',
      candidateId: 'turn-42-candidate-9',
    }, store))).rejects.toThrow('manualPayload.candidateId must reference an existing candidate');
  });

  it('rejects malformed manual payloads', async () => {
    await expect(handler(ctx(undefined))).rejects.toThrow('manualPayload must be an object');
    await expect(handler(ctx({ action: 'unknown' }))).rejects.toThrow(
      'manualPayload.action must be createCandidates or acceptCandidate',
    );
    await expect(handler(ctx({ action: 'createCandidates', turnId: '../bad' }))).rejects.toThrow(
      'turnId must be 1-128 characters',
    );
    await expect(handler(ctx({ action: 'createCandidates', count: 99 }))).rejects.toThrow(
      'manualPayload.count must be an integer',
    );
  });
});
