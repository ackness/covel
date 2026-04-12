/**
 * core-char-creator plugin discovery tests (multi-runtime).
 *
 * This plugin now hosts two runtimes:
 *   - player-init       — LLM agent, creates player via create-character tool
 *   - character-tracker — LLM agent, detects NPCs and state changes every turn
 *
 * Full execution behavior is covered by E2E tests in apps/server and
 * Playwright tests in apps/web-v2. This file only verifies the manifest
 * structure and discovery so that refactors of the plugin layout fail fast.
 *
 * Run: npx vitest run plugins/core-char-creator/tests/
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { discoverPlugins, loadPluginManifest } from '@covel/plugin-loader';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../..');

describe('core-char-creator plugin', () => {
  let discovery;
  let manifests;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    discovery = discoveries.find((d) => d.id === 'core-char-creator');
    expect(discovery).toBeDefined();
    manifests = await loadPluginManifest(discovery);
  });

  describe('discovery', () => {
    it('is recognized as a multi-runtime plugin', () => {
      expect(discovery.isMultiRuntime).toBe(true);
      expect(discovery.pluginMdPaths.length).toBeGreaterThanOrEqual(2);
    });

    it('exposes player-init and character-tracker runtimes', () => {
      const names = manifests.map((m) => m.manifest.name).sort();
      expect(names).toEqual([
        'core-char-creator/character-tracker',
        'core-char-creator/player-init',
      ]);
    });
  });

  describe('player-init runtime', () => {
    let manifest;

    beforeAll(() => {
      const m = manifests.find((x) => x.manifest.name === 'core-char-creator/player-init');
      manifest = m.manifest;
    });

    it('has priority 700 and is a core-plugin', () => {
      expect(manifest.priority).toBe(700);
      expect(manifest.pluginType).toBe('core-plugin');
    });

    it('declares create-character and create-form builtin tools', () => {
      expect(manifest.tools?.builtin).toEqual(
        expect.arrayContaining(['create-form', 'create-character']),
      );
    });

    it('injects narrator.narrativeOutput as <narrator-opening>', () => {
      expect(manifest.input?.inject).toHaveLength(1);
      const inject = manifest.input.inject[0];
      expect(inject.from).toBe('core-narrator');
      expect(inject.field).toBe('narrativeOutput');
      expect(inject.as).toBe('<narrator-opening>');
    });

    it('limits triggers to 2 (form creation + post-submit character creation)', () => {
      expect(manifest.trigger?.maxTriggerCount).toBe(2);
    });

    it('has a guard.js file to skip after player exists', () => {
      const guardPath = path.join(
        discovery.rootPath,
        'runtimes',
        'player-init',
        'guard.js',
      );
      expect(fs.existsSync(guardPath)).toBe(true);
    });

    it('declares the shared character-panel ui spec', () => {
      expect(manifest.ui?.right).toEqual(
        expect.arrayContaining(['../../ui/character-panel.json']),
      );
    });
  });

  describe('character-tracker runtime', () => {
    let manifest;

    beforeAll(() => {
      const m = manifests.find((x) => x.manifest.name === 'core-char-creator/character-tracker');
      manifest = m.manifest;
    });

    it('runs every turn during playing phase', () => {
      expect(manifest.trigger?.type).toBe('scheduled');
      expect(manifest.trigger?.interval).toBe(1);
      expect(manifest.trigger?.phases).toContain('playing');
    });

    it('declares the full character management tool suite', () => {
      expect(manifest.tools?.builtin).toEqual(
        expect.arrayContaining([
          'create-character',
          'update-character',
          'list-characters',
          'get-character',
        ]),
      );
    });

    it('injects narrator.narrativeOutput', () => {
      expect(manifest.input?.inject).toHaveLength(1);
      const inject = manifest.input.inject[0];
      expect(inject.from).toBe('core-narrator');
      expect(inject.field).toBe('narrativeOutput');
      expect(inject.as).toBe('<narrator-output>');
    });
  });
});
