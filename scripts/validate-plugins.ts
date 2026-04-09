import { discoverPlugins, loadPluginSummary, loadPluginManifest } from '../packages/plugin-loader/src/index.js';

const dir = 'plugins';
const discoveries = await discoverPlugins(dir);
console.log(`Found ${discoveries.length} plugins\n`);

for (const d of discoveries) {
  try {
    const summary = await loadPluginSummary(d);
    const manifests = await loadPluginManifest(d);
    console.log(`${d.id}: OK (p=${summary.runtimeCount} runtimes, type=${summary.pluginType})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.substring(0, 80) : String(e);
    console.log(`${d.id}: FAIL — ${msg}`);
  }
}
