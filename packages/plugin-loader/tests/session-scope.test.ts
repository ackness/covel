import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSessionScope,
  type SessionPluginScope,
} from '../src/session-scope.js';

describe('SessionPluginScope', () => {
  const corePlugins = new Set(['narrator', 'persona']);
  let scope: SessionPluginScope;

  beforeEach(() => {
    scope = createSessionScope('sess-1', ['a', 'b', 'narrator'], corePlugins);
  });

  describe('initial plugins active', () => {
    it('should have all initial plugins active', () => {
      expect(scope.isActive('a')).toBe(true);
      expect(scope.isActive('b')).toBe(true);
      expect(scope.isActive('narrator')).toBe(true);
    });
  });

  describe('enable', () => {
    it('should enable a new plugin and make it active', () => {
      const result = scope.enable('c');
      expect(result).toBe(true);
      expect(scope.isActive('c')).toBe(true);
    });
  });

  describe('disable', () => {
    it('should disable a non-core plugin and make it inactive', () => {
      const result = scope.disable('a');
      expect(result).toBe(true);
      expect(scope.isActive('a')).toBe(false);
    });
  });

  describe('disable core-plugin fails', () => {
    it('should return false when trying to disable a core plugin', () => {
      const result = scope.disable('narrator');
      expect(result).toBe(false);
      expect(scope.isActive('narrator')).toBe(true);
    });
  });

  describe('enable already enabled', () => {
    it('should return false when enabling an already active plugin', () => {
      const result = scope.enable('a');
      expect(result).toBe(false);
    });
  });

  describe('getEffectiveConfig defaults', () => {
    it('should return empty object when no override is set', () => {
      const config = scope.getEffectiveConfig('a');
      expect(config).toEqual({});
    });
  });

  describe('setConfigOverride + getEffectiveConfig', () => {
    it('should return the override config after setting it', () => {
      scope.setConfigOverride('a', { difficulty: 'hard', maxTurns: 10 });

      const config = scope.getEffectiveConfig('a');
      expect(config).toEqual({ difficulty: 'hard', maxTurns: 10 });
    });
  });

  describe('activePluginIds', () => {
    it('should reflect the current active set', () => {
      expect(scope.activePluginIds).toEqual(
        new Set(['a', 'b', 'narrator']),
      );

      scope.enable('c');
      scope.disable('b');

      expect(scope.activePluginIds).toEqual(
        new Set(['a', 'c', 'narrator']),
      );
    });
  });

  describe('sessionId', () => {
    it('should expose the session ID', () => {
      expect(scope.sessionId).toBe('sess-1');
    });
  });
});
