import { describe, it, expect } from 'vitest';
import { getPluginTrustInfo } from '../src/trust.js';

describe('getPluginTrustInfo', () => {
  describe('core- prefix = builtin', () => {
    it('should classify core-narrator as builtin with autoLoad and no approval', () => {
      const info = getPluginTrustInfo('core-narrator');

      expect(info.source).toBe('builtin');
      expect(info.autoLoad).toBe(true);
      expect(info.requiresApproval).toBe(false);
    });
  });

  describe('official ID', () => {
    it('should classify an official plugin with autoLoad and no approval', () => {
      // Use source override to simulate an official plugin
      // since the OFFICIAL_IDS set is currently empty
      const info = getPluginTrustInfo('some-official-plugin', 'official');

      expect(info.source).toBe('official');
      expect(info.autoLoad).toBe(true);
      expect(info.requiresApproval).toBe(false);
    });
  });

  describe('community', () => {
    it('should classify unknown plugins as community requiring approval', () => {
      const info = getPluginTrustInfo('my-custom-plugin');

      expect(info.source).toBe('community');
      expect(info.autoLoad).toBe(false);
      expect(info.requiresApproval).toBe(true);
    });
  });

  describe('explicit source override', () => {
    it('should use the explicit source when provided', () => {
      const info = getPluginTrustInfo('my-custom-plugin', 'builtin');

      expect(info.source).toBe('builtin');
      expect(info.autoLoad).toBe(true);
      expect(info.requiresApproval).toBe(false);
    });
  });
});
