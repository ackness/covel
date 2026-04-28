import { describe, expect, it } from 'vitest';

import {
  COVEL_FEATURE_FLAGS,
  COVEL_ENV_REGISTRY,
  getEnvDefinition,
  isEnvDefaultOn,
  isEnvEnabled,
  isEnvTruthy,
  providerApiKeysFromEnv,
  providerApiKeyEnvName,
  readEnvCsv,
  readEnvInt,
  readEnvString,
  readEnvChoice,
  readRuntimeEnv,
} from '../src/env/index.js';

describe('env registry', () => {
  it('keeps names unique', () => {
    const names = COVEL_ENV_REGISTRY.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps enum and secret definitions internally consistent', () => {
    for (const item of COVEL_ENV_REGISTRY) {
      if (item.type === 'enum') {
        expect(item.values?.length, `${item.name} enum values`).toBeGreaterThan(0);
      }
      if (item.type === 'secret') {
        expect(item.secret, `${item.name} secret marker`).toBe(true);
      }
      expect(item.description.trim().length, `${item.name} description`).toBeGreaterThan(0);
    }
  });

  it('registers every feature flag name as an active boolean env var', () => {
    for (const flag of COVEL_FEATURE_FLAGS) {
      expect(getEnvDefinition(flag)).toMatchObject({
        name: flag,
        group: expect.any(String),
        type: 'boolean',
        status: 'active',
      });
    }
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

  it('normalizes empty strings, integers and csv values', () => {
    const source = {
      EMPTY: '',
      INTEGER_OK: '42',
      INTEGER_BAD: 'twelve',
      CSV: ' https://a.test, ,https://b.test , ',
    };

    expect(readEnvString('EMPTY', 'fallback', source)).toBe('fallback');
    expect(readEnvInt('INTEGER_OK', 7, source)).toBe(42);
    expect(readEnvInt('INTEGER_BAD', 7, source)).toBe(7);
    expect(readEnvCsv('CSV', source)).toEqual(['https://a.test', 'https://b.test']);
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

  it('reads explicit runtime env values across storage, server, desktop and AI fields', () => {
    const env = readRuntimeEnv({
      STORE_BACKEND: 'pg',
      SQLITE_PATH: '/tmp/covel.db',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/covel',
      SERVER_PORT: '18080',
      NODE_ENV: 'test',
      SERVE_STATIC: 'true',
      STATIC_DIR: '/srv/web',
      DEPLOYMENT_TIER: 'demo',
      CORS_ORIGIN: 'https://a.test, https://b.test',
      ENABLE_DEBUG_PAGE: '1',
      RATE_LIMIT_RPM: '120',
      COVEL_HOME: '/home/covel',
      COVEL_DATA_ROOT: '/home/covel/data',
      COVEL_DESKTOP_REST: '1',
      COVEL_LLM_TOML: '/home/covel/llm.toml',
      COVEL_PLUGINS_DIR: '/app/plugins',
      COVEL_USER_PLUGINS_DIR: '/home/covel/plugins',
      COVEL_WORLDS_DIR: '/app/worlds',
      COVEL_USER_WORLDS_DIR: '/home/covel/worlds',
      COVEL_USER_CONFIG_DIR: '/home/covel/config',
      COVEL_LOGS_DIR: '/home/covel/logs',
      COVEL_MODEL_DB_PATH: '/home/covel/model-db.json',
      COVEL_PROMPTS_DIR: '/home/covel/prompts',
      COVEL_COMPACTOR_CONTEXT_WINDOW: '64000',
    });

    expect(env).toMatchObject({
      storeBackend: 'pg',
      sqlitePath: '/tmp/covel.db',
      databaseUrl: 'postgresql://user:pass@localhost:5432/covel',
      serverPort: 18080,
      nodeEnv: 'test',
      serveStatic: true,
      staticDir: '/srv/web',
      deploymentTier: 'demo',
      corsOrigins: ['https://a.test', 'https://b.test'],
      debugRoutes: true,
      rateLimitRpm: 120,
      covelHome: '/home/covel',
      dataRoot: '/home/covel/data',
      desktopRest: true,
      llmToml: '/home/covel/llm.toml',
      pluginsDir: '/app/plugins',
      userPluginsDir: '/home/covel/plugins',
      worldsDir: '/app/worlds',
      userWorldsDir: '/home/covel/worlds',
      userConfigDir: '/home/covel/config',
      logsDir: '/home/covel/logs',
      modelDbPath: '/home/covel/model-db.json',
      promptsDir: '/home/covel/prompts',
      compactorContextWindow: 64000,
    });
  });

  it('falls back for invalid runtime enum and integer values', () => {
    const env = readRuntimeEnv({
      STORE_BACKEND: 'postgres',
      NODE_ENV: 'staging',
      SERVER_PORT: 'abc',
      RATE_LIMIT_RPM: 'rpm',
      COVEL_COMPACTOR_CONTEXT_WINDOW: 'wide',
    });

    expect(env.storeBackend).toBe('sqlite');
    expect(env.nodeEnv).toBe('development');
    expect(env.serverPort).toBe(3001);
    expect(env.rateLimitRpm).toBe(60);
    expect(env.compactorContextWindow).toBe(32768);
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

  it('maps provider ids back to canonical API key env names', () => {
    expect(providerApiKeyEnvName('open-router')).toBe('OPEN_ROUTER_API_KEY');
    expect(providerApiKeyEnvName('DeepSeek')).toBe('DEEPSEEK_API_KEY');
    expect(providerApiKeyEnvName(' bad provider id ')).toBe('BAD_PROVIDER_ID_API_KEY');
  });
});
