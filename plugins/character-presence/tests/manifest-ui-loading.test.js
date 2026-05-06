import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discoverPlugins, loadPluginManifest, loadRuntime, parsePluginMd } from '@covel/plugin-loader';

const pluginDir = path.resolve(import.meta.dirname, '..');
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, 'PLUGIN.md');

describe('character-presence manifest and UI loading', () => {
  it('parses the manual runtime manifest through the strict schema', () => {
    const parsed = parsePluginMd(readFileSync(pluginMdPath, 'utf-8'), pluginMdPath);

    expect(parsed.manifest).toMatchObject({
      name: 'character-presence',
      pluginId: 'character-presence',
      runtimeType: 'function',
      handler: './handler.js',
      trigger: { type: 'manual' },
      ui: {
        right: ['./ui/character-presence-panel.json'],
      },
    });
  });

  it('loads the presence right panel through plugin-loader', async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find((candidate) => candidate.id === 'character-presence');
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery);
    expect(manifests).toHaveLength(1);

    const loaded = await loadRuntime(discovery, 'character-presence');
    expect(loaded.handler).toBeTypeOf('function');
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0]).toMatchObject({
      id: 'character-presence',
      dataSource: { namespace: 'presence' },
      alwaysRender: true,
    });
  });
});
