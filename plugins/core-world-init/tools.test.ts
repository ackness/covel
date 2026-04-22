import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../packages/store/src/index.ts';
import { tool, z } from '@covel/tools';
import setWorldSchema from './tools/set-world-schema.js';
import setWorldEntriesBatch from './tools/set-world-entries-batch.js';

describe('core-world-init local tools', () => {
  it('constructs the schema and entries tool modules', () => {
    const store = createMemoryStore();
    const injection = { tool, z, store };

    const schemaTool = setWorldSchema(injection);
    const entriesTool = setWorldEntriesBatch(injection);

    expect(schemaTool._type).toBe('covel-tool');
    expect(schemaTool.name).toBe('set-world-schema');
    expect(entriesTool._type).toBe('covel-tool');
    expect(entriesTool.name).toBe('set-world-entries-batch');
  });
});
