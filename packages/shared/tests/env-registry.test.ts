import { describe, expect, it } from 'vitest';

import {
  COVEL_ENV_REGISTRY,
  getEnvDefinition,
  isEnvDefaultOn,
  isEnvEnabled,
  isEnvTruthy,
  providerApiKeysFromEnv,
  readEnvChoice,
  readRuntimeEnv,
} from '../src/env/index.js';

describe('env registry', () => {
  it('keeps names unique', () => {
    const names = COVEL_ENV_REGISTRY.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('looks up definitions by name', () => {
    expect(getEnvDefinition('STORE_BACKEND')?.defaultValue).toBe('sqlite');
    expect(getEnvDefinition('COVEL_PROMPT_V2')?.group).toBe('feature');
  });

  it('parses strict feature flags', () => {
    expect(isEnvEnabled('COVEL_PROMPT_V2', { COVEL_PROMPT_V2: '1' })).toBe(true);
    expect(isEnvEnabled('COVEL_PROMPT_V2', { COVEL_PROMPT_V2: 'true' })).toBe(false);
    expect(isEnvTruthy('ENABLE_DEBUG_PAGE', { ENABLE_DEBUG_PAGE: 'true' })).toBe(true);
  });

  it('supports default-on opt-out flags', () => {
    expect(isEnvDefaultOn('COVEL_COMMIT_TXN_V1', {})).toBe(true);
    expect(isEnvDefaultOn('COVEL_COMMIT_TXN_V1', { COVEL_COMMIT_TXN_V1: '0' })).toBe(false);
    expect(isEnvDefaultOn('COVEL_COMMIT_TXN_V1', { COVEL_COMMIT_TXN_V1: 'false' })).toBe(false);
  });

  it('reads runtime defaults', () => {
    const env = readRuntimeEnv({});
    expect(env.storeBackend).toBe('sqlite');
    expect(env.sqlitePath).toBe('./data/covel.db');
    expect(env.serverPort).toBe(3001);
  });

  it('keeps invalid enum values on fallback', () => {
    expect(readEnvChoice('STORE_BACKEND', ['memory', 'sqlite', 'pg'] as const, 'sqlite', {
      STORE_BACKEND: 'postgres',
    })).toBe('sqlite');
  });

  it('collects dynamic provider API keys', () => {
    expect(providerApiKeysFromEnv({
      DEEPSEEK_API_KEY: 'sk-a',
      OPEN_ROUTER_API_KEY: 'sk-b',
      OTHER: 'x',
    })).toEqual({
      deepseek: 'sk-a',
      'open-router': 'sk-b',
    });
  });
});
