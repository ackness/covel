/**
 * Regression test: `/api/ui-specs` (and friends) must discover plugins
 * from BOTH the bundled dir and the `COVEL_USER_PLUGINS_DIR` — the
 * dashscope-image-gen button silently disappeared when the kernel
 * registered the user plugin but the UI-sync route only scanned bundled
 * plugins (2026-04-24 finding).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, type DataStore } from '@covel/store';
import {
  createPluginRegistry,
  type PluginRegistry,
} from '@covel/plugin-loader';
import type { Hono } from 'hono';
import { createMiscApiRoutes } from '../../src/routes/misc-api.js';

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const BUNDLED_PLUGIN_MANIFEST = `---
name: bundled-greeter
description: Bundled plugin
pluginType: plugin
priority: 600
runtimeType: function
handler: ./handler.js
outputKind: plugin
trigger:
  type: scheduled
  interval: 1
ui:
  right:
    - ./ui/panel.json
---
`;

const USER_PLUGIN_MANIFEST = `---
name: user-imagebox
description: User plugin
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger:
  type: manual
ui:
  right:
    - ./ui/button.json
---
`;

const BUNDLED_UI_SPEC = JSON.stringify({
  id: 'bundled-greeter',
  label: { zh: 'Greeter', en: 'Greeter' },
  view: { component: 'Text', props: { content: 'Hi' } },
});
const USER_UI_SPEC = JSON.stringify({
  id: 'user-imagebox',
  label: { zh: '用户按钮', en: 'User Button' },
  view: { component: 'Button', props: { label: 'Go' } },
});

async function writePlugin(
  root: string,
  id: string,
  manifest: string,
  uiSpecPath: string,
  uiSpecContent: string,
): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, 'ui'), { recursive: true });
  await writeFile(join(dir, 'PLUGIN.md'), manifest, 'utf-8');
  await writeFile(join(dir, 'handler.js'), 'export default async () => ({});', 'utf-8');
  await writeFile(join(dir, uiSpecPath), uiSpecContent, 'utf-8');
}

describe('GET /api/ui-specs — multi-dir plugin discovery', () => {
  let bundledDir: string;
  let userDir: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  const sessionId = 'sess-multi-dir';

  beforeEach(async () => {
    bundledDir = await mkdtemp(join(tmpdir(), 'covel-bundled-'));
    userDir = await mkdtemp(join(tmpdir(), 'covel-user-'));

    await writePlugin(
      bundledDir,
      'bundled-greeter',
      BUNDLED_PLUGIN_MANIFEST,
      'ui/panel.json',
      BUNDLED_UI_SPEC,
    );
    await writePlugin(
      userDir,
      'user-imagebox',
      USER_PLUGIN_MANIFEST,
      'ui/button.json',
      USER_UI_SPEC,
    );

    process.env.COVEL_PLUGINS_DIR = bundledDir;
    process.env.COVEL_USER_PLUGINS_DIR = userDir;

    store = createMemoryStore();
    registry = createPluginRegistry();

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: 'active',
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      // Both plugins are active in this session — the fix must expose
      // BOTH under the UI-specs endpoint, not just the bundled one.
      activePlugins: ['bundled-greeter', 'user-imagebox'],
      createdAt: new Date().toISOString(),
    });

    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    delete process.env.COVEL_PLUGINS_DIR;
    delete process.env.COVEL_USER_PLUGINS_DIR;
    await rm(bundledDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  it('materialises UI specs for both bundled and user plugins into plugin_data', async () => {
    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      right: Array<{ pluginId: string; specs: unknown[] }>;
    };
    const ids = body.right.map((entry) => entry.pluginId).sort();
    expect(ids).toEqual(['bundled-greeter', 'user-imagebox']);

    // plugin_data rows should also be populated — the frontend subscribes
    // to `plugin-data.changed` SSE on these namespaces.
    const userRows = await store.listPluginData(sessionId, 'user-imagebox', '__ui_right__');
    expect(userRows.length).toBeGreaterThan(0);
  });
});
