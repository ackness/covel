import {
  apiKeyEnvNameToProviderId,
  providerIdToApiKeyEnvName,
} from '../utils/provider-keys.js';

export type EnvValueType =
  | 'boolean'
  | 'enum'
  | 'integer'
  | 'path'
  | 'secret'
  | 'string'
  | 'url';

export type EnvGroup =
  | 'ai'
  | 'desktop'
  | 'feature'
  | 'packaging'
  | 'server'
  | 'storage'
  | 'test'
  | 'web';

export type EnvStatus = 'active' | 'documented' | 'packaging' | 'planned';

export interface EnvVarDefinition {
  readonly name: string;
  readonly group: EnvGroup;
  readonly type: EnvValueType;
  readonly status: EnvStatus;
  readonly description: string;
  readonly defaultValue?: string;
  readonly example?: string;
  readonly values?: readonly string[];
  readonly secret?: boolean;
}

export const COVEL_ENV_REGISTRY = [
  {
    name: 'STORE_BACKEND',
    group: 'storage',
    type: 'enum',
    status: 'active',
    values: ['memory', 'sqlite', 'pg'],
    defaultValue: 'sqlite',
    example: 'sqlite',
    description: 'Server DataStore backend.',
  },
  {
    name: 'SQLITE_PATH',
    group: 'storage',
    type: 'path',
    status: 'active',
    defaultValue: './data/covel.db',
    description: 'SQLite database path for the server store.',
  },
  {
    name: 'DATABASE_URL',
    group: 'storage',
    type: 'url',
    status: 'active',
    example: 'postgresql://covel:covel_dev@localhost:5432/covel',
    description: 'PostgreSQL connection string for the pg store and Drizzle.',
  },
  {
    name: 'POSTGRES_USER',
    group: 'storage',
    type: 'string',
    status: 'active',
    defaultValue: 'covel',
    description: 'Docker Compose PostgreSQL username.',
  },
  {
    name: 'POSTGRES_PASSWORD',
    group: 'storage',
    type: 'secret',
    status: 'active',
    secret: true,
    description: 'Docker Compose PostgreSQL password.',
  },
  {
    name: 'POSTGRES_DB',
    group: 'storage',
    type: 'string',
    status: 'active',
    defaultValue: 'covel',
    description: 'Docker Compose PostgreSQL database name.',
  },
  {
    name: 'POSTGRES_PORT',
    group: 'storage',
    type: 'integer',
    status: 'active',
    defaultValue: '5432',
    description: 'Host port for the Docker Compose PostgreSQL service.',
  },
  {
    name: 'SERVER_PORT',
    group: 'server',
    type: 'integer',
    status: 'active',
    defaultValue: '3001',
    description: 'HTTP server listen port.',
  },
  {
    name: 'NODE_ENV',
    group: 'server',
    type: 'enum',
    status: 'active',
    values: ['development', 'production', 'test'],
    defaultValue: 'development',
    description: 'Node runtime mode used by logging and diagnostics.',
  },
  {
    name: 'SERVE_STATIC',
    group: 'server',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Serve built web assets from the server process.',
  },
  {
    name: 'STATIC_DIR',
    group: 'server',
    type: 'path',
    status: 'active',
    defaultValue: './web-dist',
    description: 'Directory served when SERVE_STATIC is enabled.',
  },
  {
    name: 'DEPLOYMENT_TIER',
    group: 'server',
    type: 'enum',
    status: 'active',
    values: ['self', 'demo', 'commercial', 'T1'],
    defaultValue: 'self',
    description: 'Deployment posture used by security-sensitive endpoints.',
  },
  {
    name: 'CORS_ORIGIN',
    group: 'server',
    type: 'string',
    status: 'active',
    description: 'Comma-separated HTTP origins allowed by CORS.',
  },
  {
    name: 'ENABLE_DEBUG_PAGE',
    group: 'server',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables debug and internal routes in production.',
  },
  {
    name: 'RATE_LIMIT_RPM',
    group: 'server',
    type: 'integer',
    status: 'active',
    defaultValue: '60',
    description: 'Default per-IP requests per minute for rate-limited routes.',
  },
  {
    name: 'TRUSTED_PROXY_IPS',
    group: 'server',
    type: 'string',
    status: 'documented',
    description: 'Documented proxy allowlist for future rate-limit hardening.',
  },
  {
    name: 'COVEL_MEDIA_TOKEN_SECRET',
    group: 'server',
    type: 'secret',
    status: 'active',
    secret: true,
    description:
      'HMAC-SHA256 secret used to sign /api/media/:id short-lived URLs (5min TTL). Required in production; dev generates a per-process random secret if absent.',
  },
  {
    name: 'COVEL_MEDIA_CLEANUP_ENABLED',
    group: 'server',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description:
      'Enables the destructive POST /api/media/cleanup endpoint. Off by default; never enable in DEPLOYMENT_TIER=commercial without an admin auth layer (the route forces 503 there).',
  },
  {
    name: 'APP_PORT',
    group: 'server',
    type: 'integer',
    status: 'active',
    defaultValue: '3001',
    description: 'Host port for the Docker Compose app service.',
  },
  {
    name: 'COVEL_HOME',
    group: 'desktop',
    type: 'path',
    status: 'active',
    defaultValue: '~/.covel',
    description: 'Desktop config root and keys.env location.',
  },
  {
    name: 'COVEL_DATA_ROOT',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'Desktop runtime data root for SQLite, worlds, and logs.',
  },
  {
    name: 'COVEL_DESKTOP_REST',
    group: 'desktop',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables privileged desktop REST config endpoints.',
  },
  {
    name: 'COVEL_LLM_TOML',
    group: 'desktop',
    type: 'path',
    status: 'active',
    defaultValue: './llm.toml',
    description: 'Path to the active llm.toml model slot config.',
  },
  {
    name: 'COVEL_PLUGINS_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'Bundled plugin directory override.',
  },
  {
    name: 'COVEL_USER_PLUGINS_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'User plugin directory mounted by desktop shells.',
  },
  {
    name: 'COVEL_WORLDS_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'Bundled world package directory override.',
  },
  {
    name: 'COVEL_USER_WORLDS_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'User world package directory mounted by desktop shells.',
  },
  {
    name: 'COVEL_USER_CONFIG_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'Desktop config directory for model DB and settings.',
  },
  {
    name: 'COVEL_LOGS_DIR',
    group: 'desktop',
    type: 'path',
    status: 'active',
    description: 'Desktop logs directory surfaced in Settings.',
  },
  {
    name: 'COVEL_LOG_MAX_SIZE_MB',
    group: 'desktop',
    type: 'integer',
    status: 'active',
    defaultValue: '10',
    description: 'Desktop log rotation file-size cap.',
  },
  {
    name: 'COVEL_LOG_MAX_FILES',
    group: 'desktop',
    type: 'integer',
    status: 'active',
    defaultValue: '10',
    description: 'Desktop log rotation retained file count.',
  },
  {
    name: 'COVEL_APP_VERSION',
    group: 'desktop',
    type: 'string',
    status: 'active',
    defaultValue: '0.0.1-beta',
    description: 'Desktop preload app version fallback.',
  },
  {
    name: 'COVEL_AUTO_UPDATE',
    group: 'desktop',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Electron auto-updater opt-in flag.',
  },
  {
    name: 'COVEL_UPDATE_CHANNEL',
    group: 'desktop',
    type: 'enum',
    status: 'active',
    values: ['latest', 'beta', 'alpha'],
    description: 'Electron auto-updater release channel override.',
  },
  {
    name: 'COVEL_MODEL_DB_PATH',
    group: 'ai',
    type: 'path',
    status: 'active',
    description: 'Explicit model database JSON override.',
  },
  {
    name: 'COVEL_PROMPTS_DIR',
    group: 'ai',
    type: 'path',
    status: 'active',
    description: 'Prompt template root directory override.',
  },
  {
    name: 'LANGFUSE_PUBLIC_KEY',
    group: 'ai',
    type: 'string',
    status: 'active',
    description: 'Langfuse public key for LLM trace export.',
  },
  {
    name: 'LANGFUSE_SECRET_KEY',
    group: 'ai',
    type: 'secret',
    status: 'active',
    secret: true,
    description: 'Langfuse secret key for LLM trace export.',
  },
  {
    name: 'LANGFUSE_BASE_URL',
    group: 'ai',
    type: 'url',
    status: 'active',
    defaultValue: 'https://cloud.langfuse.com',
    description: 'Langfuse API base URL.',
  },
  {
    name: 'COVEL_LLM_RETRY_DISABLED',
    group: 'ai',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Disables provider HTTP retry when set to 1.',
  },
  {
    name: 'COVEL_LLM_REPLAY',
    group: 'ai',
    type: 'enum',
    status: 'documented',
    values: ['auto', 'record', 'replay'],
    description: 'Documented dev LLM replay cache mode.',
  },
  {
    name: 'COVEL_LLM_REPLAY_DIR',
    group: 'ai',
    type: 'path',
    status: 'documented',
    defaultValue: 'debugs/llm-cache',
    description: 'Documented dev LLM replay cache directory.',
  },
  {
    name: 'COVEL_ALLOWED_LLM_HOSTS',
    group: 'ai',
    type: 'string',
    status: 'documented',
    description: 'Documented custom LLM host allowlist.',
  },
  {
    name: 'COVEL_MEMORY_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables core memory blocks, memory tools, and memory updater.',
  },
  {
    name: 'COVEL_WORKING_MEMORY_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables framework working-memory prompt injection and writes.',
  },
  {
    name: 'COVEL_COMPACTOR_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables message compaction and summary substitution.',
  },
  {
    name: 'COVEL_COMPACTOR_CONTEXT_WINDOW',
    group: 'feature',
    type: 'integer',
    status: 'active',
    defaultValue: '32768',
    description: 'Compactor context window used for threshold comparisons.',
  },
  {
    name: 'COVEL_PROMPT_V2',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables V2 prompt assembly for plugins that opt in.',
  },
  {
    name: 'COVEL_PROMPT_CACHE_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables prompt-cache breakpoint emission in V2 prompts.',
  },
  {
    name: 'COVEL_CONTEXT_BUDGET_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables prompt budget pruning when caller supplies estimator config.',
  },
  {
    name: 'COVEL_COMMIT_TXN_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'true',
    description: 'Wraps commitAll in a store transaction by default.',
  },
  {
    name: 'COVEL_SUSPEND_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables suspend/resume runtime flow and routes.',
  },
  {
    name: 'COVEL_SNAPSHOTS_V1',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables manual snapshots, forks, and auto snapshots.',
  },
  {
    name: 'COVEL_SESSION_CONTEXT',
    group: 'feature',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables unified SessionContextSnapshot wiring.',
  },
  {
    name: 'COVEL_TRACE_TRUNCATE',
    group: 'feature',
    type: 'boolean',
    status: 'planned',
    defaultValue: 'false',
    description: 'Planned trace payload truncation switch.',
  },
  {
    name: 'RUNTIME_HOST',
    group: 'web',
    type: 'string',
    status: 'active',
    defaultValue: '127.0.0.1',
    description: 'Vite dev proxy target host for server API calls.',
  },
  {
    name: 'RUNTIME_PORT',
    group: 'web',
    type: 'integer',
    status: 'active',
    defaultValue: '3001',
    description: 'Vite dev proxy target port for server API calls.',
  },
  {
    name: 'VITE_API_URL',
    group: 'web',
    type: 'url',
    status: 'documented',
    description: 'Typed browser env placeholder from vite-env.d.ts.',
  },
  {
    name: 'E2E_BASE_URL',
    group: 'test',
    type: 'url',
    status: 'active',
    defaultValue: 'http://localhost:3001',
    description: 'Playwright base URL override.',
  },
  {
    name: 'E2E_MODEL_SLOT',
    group: 'test',
    type: 'string',
    status: 'active',
    defaultValue: 'e2e',
    description: 'Model slot used by the e2e plugin verification script.',
  },
  {
    name: 'CI',
    group: 'test',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'CI mode for lint and Playwright behavior.',
  },
  {
    name: 'LIVE_LLM_ENABLED',
    group: 'test',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables live LLM provider tests.',
  },
  {
    name: 'LIVE_IMAGE_ENABLED',
    group: 'test',
    type: 'boolean',
    status: 'active',
    defaultValue: 'false',
    description: 'Enables live image-generation provider tests.',
  },
  {
    name: 'BASE_URL',
    group: 'test',
    type: 'url',
    status: 'active',
    defaultValue: 'http://localhost:5173',
    description: 'README screenshot script frontend URL.',
  },
  {
    name: 'SESSION_ID',
    group: 'test',
    type: 'string',
    status: 'active',
    description: 'README screenshot script session id.',
  },
  {
    name: 'COVEL_PG_PREFLIGHT_HOST',
    group: 'test',
    type: 'string',
    status: 'active',
    defaultValue: '127.0.0.1',
    description: 'dev:pg TCP preflight target host.',
  },
  {
    name: 'COVEL_PG_PREFLIGHT_PORT',
    group: 'test',
    type: 'integer',
    status: 'active',
    defaultValue: '5432',
    description: 'dev:pg TCP preflight target port.',
  },
  {
    name: 'COVEL_PG_PREFLIGHT_SKIP',
    group: 'test',
    type: 'boolean',
    status: 'documented',
    defaultValue: 'false',
    description: 'Documented dev:pg preflight bypass flag.',
  },
  {
    name: 'COVEL_STORY_BASE_URL',
    group: 'test',
    type: 'url',
    status: 'documented',
    description: 'Documented aimock story endpoint override.',
  },
  {
    name: 'COVEL_PLUGIN_BASE_URL',
    group: 'test',
    type: 'url',
    status: 'documented',
    description: 'Documented aimock plugin endpoint override.',
  },
  {
    name: 'CSC_LINK',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'electron-builder code-signing certificate path or URL.',
  },
  {
    name: 'CSC_KEY_PASSWORD',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'electron-builder code-signing certificate password.',
  },
  {
    name: 'WIN_CSC_TIMESTAMP_SERVER',
    group: 'packaging',
    type: 'url',
    status: 'packaging',
    defaultValue: 'http://timestamp.digicert.com',
    description: 'Windows signing timestamp server.',
  },
  {
    name: 'APPLE_ID',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Apple Developer account for notarization.',
  },
  {
    name: 'APPLE_APP_SPECIFIC_PASSWORD',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'electron-builder Apple notarization app-specific password.',
  },
  {
    name: 'APPLE_TEAM_ID',
    group: 'packaging',
    type: 'string',
    status: 'packaging',
    description: 'Apple Developer Team ID.',
  },
  {
    name: 'APPLE_SIGNING_IDENTITY',
    group: 'packaging',
    type: 'string',
    status: 'packaging',
    description: 'Tauri macOS signing identity.',
  },
  {
    name: 'APPLE_CERTIFICATE',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Tauri base64-encoded Apple certificate.',
  },
  {
    name: 'APPLE_CERTIFICATE_PASSWORD',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Tauri Apple certificate password.',
  },
  {
    name: 'APPLE_PASSWORD',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Tauri Apple notarization app-specific password.',
  },
  {
    name: 'TAURI_SIGNING_PRIVATE_KEY',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Tauri updater signing private key.',
  },
  {
    name: 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    group: 'packaging',
    type: 'secret',
    status: 'packaging',
    secret: true,
    description: 'Tauri updater signing key password.',
  },
] as const satisfies readonly EnvVarDefinition[];

export type CovelEnvName = (typeof COVEL_ENV_REGISTRY)[number]['name'];

export const COVEL_FEATURE_FLAGS = [
  'COVEL_MEMORY_V1',
  'COVEL_WORKING_MEMORY_V1',
  'COVEL_COMPACTOR_V1',
  'COVEL_PROMPT_V2',
  'COVEL_PROMPT_CACHE_V1',
  'COVEL_CONTEXT_BUDGET_V1',
  'COVEL_SUSPEND_V1',
  'COVEL_SNAPSHOTS_V1',
  'COVEL_SESSION_CONTEXT',
  'COVEL_LLM_RETRY_DISABLED',
] as const;

export type CovelFeatureFlag = (typeof COVEL_FEATURE_FLAGS)[number];

export type EnvSource = Record<string, string | undefined>;

function defaultSource(): EnvSource {
  const globalProcess = (globalThis as { process?: { env?: EnvSource } }).process;
  return globalProcess?.env ?? {};
}

export function getEnvDefinition(name: string): EnvVarDefinition | undefined {
  return COVEL_ENV_REGISTRY.find((item) => item.name === name);
}

export function readEnvString(
  name: CovelEnvName | string,
  fallback?: string,
  source: EnvSource = defaultSource(),
): string | undefined {
  const value = source[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function readEnvInt(
  name: CovelEnvName | string,
  fallback: number,
  source: EnvSource = defaultSource(),
): number {
  const raw = readEnvString(name, undefined, source);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readEnvChoice<T extends string>(
  name: CovelEnvName | string,
  choices: readonly T[],
  fallback: T,
  source: EnvSource = defaultSource(),
): T {
  const raw = readEnvString(name, undefined, source);
  return choices.includes(raw as T) ? (raw as T) : fallback;
}

export function readEnvCsv(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): string[] {
  const raw = readEnvString(name, undefined, source);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isEnvEnabled(
  name: CovelFeatureFlag,
  source: EnvSource = defaultSource(),
): boolean {
  return source[name] === '1';
}

export function isEnvTruthy(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): boolean {
  const raw = source[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export function isEnvDefaultOn(
  name: CovelEnvName | string,
  source: EnvSource = defaultSource(),
): boolean {
  const raw = source[name]?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export function providerApiKeysFromEnv(
  source: EnvSource = defaultSource(),
): Record<string, string> {
  const apiKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const provider = apiKeyEnvNameToProviderId(key);
    if (provider && value) apiKeys[provider] = value;
  }
  return apiKeys;
}

export function providerApiKeyEnvName(providerId: string): string | null {
  return providerIdToApiKeyEnvName(providerId);
}

export function readRuntimeEnv(source: EnvSource = defaultSource()) {
  return {
    storeBackend: readEnvChoice('STORE_BACKEND', ['memory', 'sqlite', 'pg'] as const, 'sqlite', source),
    sqlitePath: readEnvString('SQLITE_PATH', './data/covel.db', source)!,
    databaseUrl: readEnvString('DATABASE_URL', undefined, source),
    serverPort: readEnvInt('SERVER_PORT', 3001, source),
    nodeEnv: readEnvChoice('NODE_ENV', ['development', 'production', 'test'] as const, 'development', source),
    serveStatic: isEnvTruthy('SERVE_STATIC', source),
    staticDir: readEnvString('STATIC_DIR', './web-dist', source)!,
    deploymentTier: readEnvString('DEPLOYMENT_TIER', 'self', source)!,
    corsOrigins: readEnvCsv('CORS_ORIGIN', source),
    debugRoutes: isEnvTruthy('ENABLE_DEBUG_PAGE', source),
    rateLimitRpm: readEnvInt('RATE_LIMIT_RPM', 60, source),
    covelHome: readEnvString('COVEL_HOME', undefined, source),
    dataRoot: readEnvString('COVEL_DATA_ROOT', undefined, source),
    desktopRest: isEnvTruthy('COVEL_DESKTOP_REST', source),
    llmToml: readEnvString('COVEL_LLM_TOML', undefined, source),
    pluginsDir: readEnvString('COVEL_PLUGINS_DIR', undefined, source),
    userPluginsDir: readEnvString('COVEL_USER_PLUGINS_DIR', undefined, source),
    worldsDir: readEnvString('COVEL_WORLDS_DIR', undefined, source),
    userWorldsDir: readEnvString('COVEL_USER_WORLDS_DIR', undefined, source),
    userConfigDir: readEnvString('COVEL_USER_CONFIG_DIR', undefined, source),
    logsDir: readEnvString('COVEL_LOGS_DIR', undefined, source),
    modelDbPath: readEnvString('COVEL_MODEL_DB_PATH', undefined, source),
    promptsDir: readEnvString('COVEL_PROMPTS_DIR', undefined, source),
    compactorContextWindow: readEnvInt('COVEL_COMPACTOR_CONTEXT_WINDOW', 32768, source),
  };
}
