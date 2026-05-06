import { describe, expect, it } from 'vitest';
import { getPendingProposals } from '@covel/tools';
import handler from '../handler.js';

function ctx(manualPayload, store = {}) {
  return {
    sessionId: 'sess-identity',
    turnId: 'turn-identity',
    pluginId: 'player-identity',
    runtimeId: 'player-identity',
    playerMessage: '',
    store,
    completedResults: new Map(),
    config: {},
    manualPayload,
  };
}

describe('player-identity handler', () => {
  it('saves and activates a profile', async () => {
    const result = await handler(ctx({
      profile: {
        schemaVersion: 1,
        id: 'wanderer',
        name: 'Wanderer',
        description: 'A cautious outsider.',
      },
    }));

    expect(result).toEqual({
      saved: true,
      profileId: 'wanderer',
      activated: true,
      characterId: 'player-wanderer',
    });

    const proposals = getPendingProposals(result);
    expect(proposals.map((proposal) => proposal.type)).toEqual([
      'plugin.data',
      'plugin.data',
      'character.upsert',
    ]);
    expect(proposals[0]).toMatchObject({
      type: 'plugin.data',
      payload: {
        namespace: 'profiles',
        key: 'wanderer',
        value: {
          profile: {
            schemaVersion: 1,
            id: 'wanderer',
            name: 'Wanderer',
            description: 'A cautious outsider.',
          },
          boundCharacterId: 'player-wanderer',
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: 'plugin.data',
      payload: {
        namespace: 'session-binding',
        key: 'current',
        value: {
          profileId: 'wanderer',
          characterId: 'player-wanderer',
        },
      },
    });
    expect(proposals[2]).toMatchObject({
      type: 'character.upsert',
      payload: {
        id: 'player-wanderer',
        name: 'Wanderer',
        type: 'player',
        description: 'A cautious outsider.',
        fields: {
          identityProfileId: 'wanderer',
          identityProfileName: 'Wanderer',
        },
        mirrorPluginId: 'player-identity',
      },
    });
  });

  it('preserves existing player fields when binding', async () => {
    const store = {
      async listCharacters(sessionId) {
        expect(sessionId).toBe('sess-identity');
        return [
          {
            id: 'player-1',
            name: 'Existing Hero',
            type: 'player',
            description: 'Existing description',
            fields: { level: 3 },
            version: 7,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ];
      },
    };

    const result = await handler(ctx({
      profileJson: JSON.stringify({
        schemaVersion: 1,
        id: 'scholar',
        name: 'Scholar',
        description: 'Studies old ruins.',
        fields: { origin: 'archive' },
      }),
    }, store));

    expect(result.characterId).toBe('player-1');
    const proposals = getPendingProposals(result);
    expect(proposals[2]).toMatchObject({
      type: 'character.upsert',
      payload: {
        id: 'player-1',
        name: 'Existing Hero',
        type: 'player',
        description: 'Studies old ruins.',
        fields: {
          level: 3,
          origin: 'archive',
          identityProfileId: 'scholar',
          identityProfileName: 'Scholar',
        },
        version: 7,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('can save without activation or character binding', async () => {
    const result = await handler(ctx({
      activate: false,
      bindToPlayer: false,
      profile: {
        schemaVersion: 1,
        id: 'observer',
        name: 'Observer',
      },
    }));

    expect(result).toEqual({
      saved: true,
      profileId: 'observer',
      activated: false,
    });
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.namespace).toBe('profiles');
  });

  it('rejects malformed profile payloads', async () => {
    await expect(handler(ctx({ profileJson: '{bad json' })))
      .rejects.toThrow('manualPayload.profileJson must be valid JSON');

    await expect(handler(ctx({ profile: { id: 'missing-name' } })))
      .rejects.toThrow('profile.name must be a non-empty string');

    await expect(handler(ctx({
      profile: { schemaVersion: 1, id: '../escape', name: 'Escape' },
    }))).rejects.toThrow('profile.id must be 1-128 characters');

    await expect(handler(ctx({
      profile: {
        schemaVersion: 1,
        id: 'large-profile',
        name: 'Large Profile',
        description: 'x'.repeat(70_000),
      },
    }))).rejects.toThrow('profile is too large');
  });
});
