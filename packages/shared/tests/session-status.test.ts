import { describe, it, expect } from 'vitest';
import type { SessionStatus, Session } from '../src/types/session.js';

describe('SessionStatus', () => {
  it('allows the three documented values', () => {
    const active: SessionStatus = 'active';
    const paused: SessionStatus = 'paused';
    const ended: SessionStatus = 'ended';
    expect([active, paused, ended]).toEqual(['active', 'paused', 'ended']);
  });

  it('Session.status is required', () => {
    const s: Session = {
      id: 's-1',
      status: 'active',
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [],
      locale: 'zh-CN',
      createdAt: 'now',
      updatedAt: 'now',
    };
    expect(s.status).toBe('active');
  });
});
