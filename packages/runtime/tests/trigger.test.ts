import { describe, it, expect } from 'vitest';
import type { RuntimeManifest } from '@covel/shared';
import type { TriggerContext } from '../src/types.js';
import { shouldTrigger } from '../src/trigger.js';

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
}

function makeContext(overrides?: Partial<TriggerContext>): TriggerContext {
  return {
    sessionId: 'sess-1',
    turnNumber: 5,
    playingTurnNumber: 5,
    triggerCount: 0,
    turnsSinceLastTrigger: 999,
    pendingEventTopics: [],
    hasUpstreamFailure: false,
    isManualTrigger: false,
    ...overrides,
  };
}

describe('shouldTrigger', () => {
  // 1. auto (default) — no trigger config → true
  it('should return true when no trigger config (defaults to auto)', () => {
    const manifest = makeManifest();
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 2. auto explicit — trigger.type: 'auto' → true
  it('should return true for explicit auto trigger type', () => {
    const manifest = makeManifest({ trigger: { type: 'auto' } });
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 3. manual, not triggered
  it('should return false for manual trigger when isManualTrigger is false', () => {
    const manifest = makeManifest({ trigger: { type: 'manual' } });
    const ctx = makeContext({ isManualTrigger: false });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 4. manual, triggered
  it('should return true for manual trigger when isManualTrigger is true', () => {
    const manifest = makeManifest({ trigger: { type: 'manual' } });
    const ctx = makeContext({ isManualTrigger: true });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 5. scheduled, on interval
  it('should return true for scheduled trigger when turnNumber is on interval', () => {
    const manifest = makeManifest({ trigger: { type: 'scheduled', interval: 3 } });
    const ctx = makeContext({ turnNumber: 6 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 6. scheduled, off interval
  it('should return false for scheduled trigger when turnNumber is off interval', () => {
    const manifest = makeManifest({ trigger: { type: 'scheduled', interval: 3 } });
    const ctx = makeContext({ turnNumber: 7 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 7. event, matching topic
  it('should return true for event trigger when topic matches pending events', () => {
    const manifest = makeManifest({
      trigger: { type: 'event', topic: 'quest.completed' },
    });
    const ctx = makeContext({ pendingEventTopics: ['quest.completed'] });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 8. event, no match
  it('should return false for event trigger when topic does not match', () => {
    const manifest = makeManifest({
      trigger: { type: 'event', topic: 'quest.completed' },
    });
    const ctx = makeContext({ pendingEventTopics: ['combat.start'] });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 9. error-retry, has failure
  it('should return true for error-retry when hasUpstreamFailure is true', () => {
    const manifest = makeManifest({ trigger: { type: 'error-retry' } });
    const ctx = makeContext({ hasUpstreamFailure: true });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 10. error-retry, no failure
  it('should return false for error-retry when hasUpstreamFailure is false', () => {
    const manifest = makeManifest({ trigger: { type: 'error-retry' } });
    const ctx = makeContext({ hasUpstreamFailure: false });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 11. conditional with unknown condition returns false
  it('should return false for conditional trigger with unknown condition', () => {
    const manifest = makeManifest({
      trigger: { type: 'conditional', condition: 'has-write-conflicts' },
    });
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 12. maxTriggerCount exceeded
  it('should return false when triggerCount >= maxTriggerCount', () => {
    const manifest = makeManifest({
      trigger: { type: 'auto', maxTriggerCount: 3 },
    });
    const ctx = makeContext({ triggerCount: 3 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 13. cooldownTurns not met
  it('should return false when turnsSinceLastTrigger < cooldownTurns', () => {
    const manifest = makeManifest({
      trigger: { type: 'auto', cooldownTurns: 5 },
    });
    const ctx = makeContext({ turnsSinceLastTrigger: 2 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 14. maxRetryCount exceeded for error-retry
  it('should return false for error-retry when triggerCount >= maxRetryCount', () => {
    const manifest = makeManifest({
      trigger: { type: 'error-retry', maxRetryCount: 2 },
    });
    const ctx = makeContext({ hasUpstreamFailure: true, triggerCount: 2 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // ── PR-2: startTurn is compared against playingTurnNumber, not turnNumber

  it('should gate by playingTurnNumber when startTurn is set', () => {
    const manifest = makeManifest({
      trigger: { type: 'auto', startTurn: 2 },
    });
    // Global turnNumber is high but playingTurnNumber is below startTurn
    const ctx = makeContext({ turnNumber: 10, playingTurnNumber: 1 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  it('should trigger once playingTurnNumber reaches startTurn', () => {
    const manifest = makeManifest({
      trigger: { type: 'auto', startTurn: 2 },
    });
    const ctx = makeContext({ turnNumber: 3, playingTurnNumber: 2 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  it('should ignore global turnNumber when startTurn is set', () => {
    // Scenario: large global turnNumber because of many pre-game messages,
    // but session just entered playing (playingTurnNumber=0). A plugin
    // declaring startTurn=1 should NOT fire yet.
    const manifest = makeManifest({
      trigger: { type: 'auto', startTurn: 1 },
    });
    const ctx = makeContext({ turnNumber: 15, playingTurnNumber: 0 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  it('should not gate when startTurn is undefined', () => {
    const manifest = makeManifest({ trigger: { type: 'auto' } });
    const ctx = makeContext({ turnNumber: 0, playingTurnNumber: 0 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });
});
