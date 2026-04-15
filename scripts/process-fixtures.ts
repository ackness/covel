#!/usr/bin/env node
/**
 * Build stable aimock fixtures.json files for docker replay.
 *
 * Default mode:
 * - Reads hand-authored fixtures from `fixtures/aimock/{story,plugin}/authored/*.json`
 * - Merges them into `fixtures.json`
 * - Rejects empty `match` objects and rejects `sequenceIndex` by default
 *
 * Legacy opt-in mode:
 * - `--include-sequence-index-recordings`
 * - Also converts `recorded/*.json` into legacy `sequenceIndex` fixtures
 * - Kept only for debugging / migration, not recommended for normal replay
 *
 * Why:
 * - aimock officially supports semantic match fields such as `userMessage`,
 *   `toolCallId`, `toolName`, `model`, `responseFormat`
 * - raw `recorded/*.json` files only contain responses, so converting them into
 *   replay fixtures by call order is inherently brittle
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_SEQUENCE_INDEX = process.argv.includes('--include-sequence-index-recordings');

interface FixtureFile {
  fixtures: Array<{ match: Record<string, unknown>; response: unknown }>;
}

interface FixtureTarget {
  authoredDir: string;
  recordedDir: string;
  outFile: string;
  label: string;
  matchBase: Record<string, string>;
}

const TARGETS: FixtureTarget[] = [
  {
    authoredDir: join(ROOT, 'fixtures/aimock/story/authored'),
    recordedDir: join(ROOT, 'fixtures/aimock/story/recorded'),
    outFile: join(ROOT, 'fixtures/aimock/story/fixtures.json'),
    label: 'story (DeepSeek via port 4010)',
    matchBase: { model: 'deepseek-chat' },
  },
  {
    authoredDir: join(ROOT, 'fixtures/aimock/plugin/authored'),
    recordedDir: join(ROOT, 'fixtures/aimock/plugin/recorded'),
    outFile: join(ROOT, 'fixtures/aimock/plugin/fixtures.json'),
    label: 'plugin (DashScope via port 4011)',
    matchBase: { model: 'qwen3.5-35b-a3b' },
  },
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function sortKey(filename: string): string {
  const m = filename.match(/openai-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)/);
  return m ? m[1] : filename;
}

function previewResponse(response: unknown): string {
  if (!response || typeof response !== 'object') return String(response).slice(0, 60);
  const r = response as Record<string, unknown>;
  if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
    const names = (r.toolCalls as Array<{ name?: string }>).map((t) => t.name ?? '?');
    return `toolCalls: ${names.join(', ')}`;
  }
  if (typeof r.content === 'string') {
    return `content: "${r.content.slice(0, 48).replace(/\n/g, '↵')}…"`;
  }
  return JSON.stringify(r).slice(0, 60);
}

function loadAuthoredFixtures(target: FixtureTarget): Array<{ match: Record<string, unknown>; response: unknown }> {
  if (!existsSync(target.authoredDir)) return [];
  const files = readdirSync(target.authoredDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();

  const merged: Array<{ match: Record<string, unknown>; response: unknown }> = [];

  for (const file of files) {
    const fullPath = join(target.authoredDir, file);
    const raw = readJson<FixtureFile>(fullPath);
    for (const fixture of raw.fixtures ?? []) {
      const match = fixture.match ?? {};
      if (Object.keys(match).length === 0) {
        throw new Error(`Authored fixture ${file} contains empty match: ${JSON.stringify(fixture.response).slice(0, 80)}`);
      }
      if ('sequenceIndex' in match) {
        throw new Error(`Authored fixture ${file} uses sequenceIndex; this compiler only allows stable semantic matchers`);
      }
      merged.push({
        match: { ...target.matchBase, ...match },
        response: fixture.response,
      });
    }
  }

  return merged;
}

function loadLegacySequenceFixtures(target: FixtureTarget): Array<{ match: Record<string, unknown>; response: unknown }> {
  if (!existsSync(target.recordedDir)) return [];
  const files = readdirSync(target.recordedDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const fixtures: Array<{ match: Record<string, unknown>; response: unknown }> = [];
  for (let i = 0; i < files.length; i++) {
    const fullPath = join(target.recordedDir, files[i]);
    const raw = readJson<FixtureFile>(fullPath);
    for (const fixture of raw.fixtures ?? []) {
      fixtures.push({
        match: { ...target.matchBase, sequenceIndex: i },
        response: fixture.response,
      });
    }
  }
  return fixtures;
}

let total = 0;

for (const target of TARGETS) {
  console.log(`\n📁 ${target.label}`);

  const authored = loadAuthoredFixtures(target);
  if (authored.length > 0) {
    console.log(`   authored fixtures: ${authored.length}`);
    for (const fixture of authored) {
      console.log(`   [authored] ${JSON.stringify(fixture.match)} → ${previewResponse(fixture.response)}`);
    }
  } else {
    console.log(`   authored fixtures: 0`);
  }

  let fixtures = [...authored];

  if (INCLUDE_SEQUENCE_INDEX) {
    const legacy = loadLegacySequenceFixtures(target);
    if (legacy.length > 0) {
      console.log(`   legacy sequence fixtures: ${legacy.length}`);
      for (const fixture of legacy) {
        console.log(`   [legacy] ${JSON.stringify(fixture.match)} → ${previewResponse(fixture.response)}`);
      }
      fixtures = fixtures.concat(legacy);
    } else {
      console.log('   legacy sequence fixtures: 0');
    }
  }

  if (fixtures.length === 0) {
    console.log('   ⏭  no fixtures to write');
    continue;
  }

  const output = { fixtures };
  if (DRY_RUN) {
    console.log(`   [dry-run] would write ${target.outFile} (${fixtures.length} fixtures)`);
  } else {
    const outDir = dirname(target.outFile);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(target.outFile, JSON.stringify(output, null, 2) + '\n');
    console.log(`   ✅ wrote ${target.outFile} (${fixtures.length} fixtures)`);
    total += fixtures.length;
  }
}

if (!DRY_RUN) {
  console.log(`\n✅ Finished. Total fixtures written: ${total}`);
  if (INCLUDE_SEQUENCE_INDEX) {
    console.log('   Warning: legacy sequenceIndex fixtures were included');
  } else {
    console.log('   Stable mode: only semantic authored fixtures were compiled');
  }
}
