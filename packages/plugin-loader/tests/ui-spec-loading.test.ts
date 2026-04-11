import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '../src/index.js';

describe('UI spec loading', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'covel-ui-test-'));

    // Plugin with UI specs
    const pluginDir = path.join(tmpDir, 'test-ui-plugin');
    await fs.mkdir(path.join(pluginDir, 'ui'), { recursive: true });

    await fs.writeFile(
      path.join(pluginDir, 'PLUGIN.md'),
      `---
name: test-ui-plugin
description: Plugin with UI specs
priority: 500
ui:
  right:
    - ./ui/panel.json
  message:
    - ./ui/block.json
---

Test prompt.
`,
    );

    await fs.writeFile(
      path.join(pluginDir, 'ui', 'panel.json'),
      JSON.stringify({
        id: 'test-panel',
        label: { zh: '测试面板', en: 'Test Panel' },
        icon: 'layout',
        dataSource: { namespace: 'entries' },
        view: { component: 'Stack', children: [] },
      }),
    );

    await fs.writeFile(
      path.join(pluginDir, 'ui', 'block.json'),
      JSON.stringify({
        id: 'test-block',
        trigger: 'test-discovery',
        view: { component: 'Card', children: [] },
      }),
    );

    // Plugin without UI
    const noUiDir = path.join(tmpDir, 'no-ui-plugin');
    await fs.mkdir(noUiDir, { recursive: true });
    await fs.writeFile(
      path.join(noUiDir, 'PLUGIN.md'),
      `---
name: no-ui-plugin
description: No UI
priority: 500
---

Prompt.
`,
    );

    // Plugin with path traversal attack
    const evilDir = path.join(tmpDir, 'evil-plugin');
    await fs.mkdir(evilDir, { recursive: true });
    await fs.writeFile(
      path.join(evilDir, 'PLUGIN.md'),
      `---
name: evil-plugin
description: Evil
priority: 500
ui:
  right:
    - ../../etc/passwd
---

Prompt.
`,
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should parse ui field from PLUGIN.md frontmatter', async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === 'test-ui-plugin');
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery!);
    expect(manifests[0].manifest.ui).toBeDefined();
    expect(manifests[0].manifest.ui?.right).toEqual(['./ui/panel.json']);
    expect(manifests[0].manifest.ui?.message).toEqual(['./ui/block.json']);
  });

  it('should load UI spec JSON files in loadRuntime', async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === 'test-ui-plugin')!;
    const loaded = await loadRuntime(discovery, 'test-ui-plugin');

    expect(loaded.uiSpecs).toBeDefined();
    expect(loaded.uiSpecs?.right).toHaveLength(1);
    expect(loaded.uiSpecs?.right?.[0].id).toBe('test-panel');
    expect(loaded.uiSpecs?.right?.[0].icon).toBe('layout');
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0].id).toBe('test-block');
  });

  it('should handle plugin with no ui field', async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === 'no-ui-plugin')!;
    const loaded = await loadRuntime(discovery, 'no-ui-plugin');

    expect(loaded.uiSpecs).toBeUndefined();
  });

  it('should reject path traversal in ui file paths', async () => {
    const discoveries = await discoverPlugins(tmpDir);
    const discovery = discoveries.find((d) => d.id === 'evil-plugin')!;

    await expect(loadRuntime(discovery, 'evil-plugin')).rejects.toThrow(/path traversal/i);
  });
});
