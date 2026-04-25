#!/usr/bin/env -S node --import tsx

import { runRuntimeDebug, runRuntimeCases } from './runner.js';

interface CliOptions {
  target?: string;
  runtimeId?: string;
  pluginId?: string;
  pluginsDir?: string;
  sessionId?: string;
  locale?: string;
  message?: string;
  payload?: Record<string, unknown>;
  config?: Record<string, unknown>;
  userSettings?: Record<string, unknown>;
  llmResponse?: Record<string, unknown>;
  llmContent?: string;
  llmObject?: Record<string, unknown>;
  mockImageUrl?: string;
  showPrompts?: boolean;
  ignoreUpstreams?: boolean;
  mode?: 'mock' | 'live';
  caseName?: string;
  pretty?: boolean;
}

const HELP = `Usage:
  covel-test-runtime <pluginId|runtimeId> [options]
  test_runtime <pluginId|runtimeId> [options]

Options:
  --plugin <id>              Plugin id. Defaults to runtimeId prefix.
  --plugins-dir <path>       Plugin directory. Defaults to ~/.covel/plugins.
  --session <id>             Session id. Defaults to debug-<timestamp>.
  --case <name>              Run one plugin-defined case by name.
  --mode <mock|live>         mock uses fake LLM/gateway; live uses real llm.toml/provider APIs.
  --live                     Shortcut for --mode live.
  --locale <locale>          Locale. Defaults to zh-CN.
  --message <text>           Player message for context. Defaults to empty.
  --payload <json>           manualTrigger payload JSON.
  --config <json>            Config object returned by getConfig().
  --user-settings <json>     Plugin userSettings bucket for this plugin.
  --llm-content <text>       Mock LLM content for agent runtimes.
  --llm-object <json>        Mock LLM JSON object content (auto stringified — easier than --llm-content for JSON envelopes).
  --llm-response <json>      Full mock LLM response JSON.
  --mock-image-url <url>     Mock gateway image URL.
  --show-prompts             Include captured LLM messages in output.
  --ignore-upstreams         Clear upstreamRequired during this debug run.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help.

Example:
  covel-test-runtime dashscope-image-gen --mode live --case generate-image-json --pretty

  covel-test-runtime dashscope-image-gen/prompt-generator \\
    --plugins-dir ~/.covel/plugins \\
    --payload '{"prompt":"画一张奇幻城市插画"}' \\
    --pretty
`;

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--') continue;
    switch (arg) {
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
      case '--plugin':
        options.pluginId = next();
        break;
      case '--plugins-dir':
        options.pluginsDir = next();
        break;
      case '--session':
        options.sessionId = next();
        break;
      case '--case':
        options.caseName = next();
        break;
      case '--mode': {
        const value = next();
        if (value !== 'mock' && value !== 'live') {
          throw new Error('--mode must be "mock" or "live"');
        }
        options.mode = value;
        break;
      }
      case '--live':
        options.mode = 'live';
        break;
      case '--locale':
        options.locale = next();
        break;
      case '--message':
        options.message = next();
        break;
      case '--payload':
        options.payload = parseJsonObject(next(), '--payload');
        break;
      case '--config':
        options.config = parseJsonObject(next(), '--config');
        break;
      case '--user-settings':
        options.userSettings = parseJsonObject(next(), '--user-settings');
        break;
      case '--llm-response':
        options.llmResponse = parseJsonObject(next(), '--llm-response');
        break;
      case '--llm-content':
        options.llmContent = next();
        break;
      case '--llm-object':
        options.llmObject = parseJsonObject(next(), '--llm-object');
        break;
      case '--mock-image-url':
        options.mockImageUrl = next();
        break;
      case '--show-prompts':
        options.showPrompts = true;
        break;
      case '--ignore-upstreams':
        options.ignoreUpstreams = true;
        break;
      case '--pretty':
        options.pretty = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length > 0) options.target = positional[0];
  if (options.target) {
    if (options.target.includes('/')) {
      options.runtimeId = options.target;
    } else {
      options.pluginId = options.target;
    }
  }
  if (!options.runtimeId && !options.pluginId) {
    throw new Error('pluginId or runtimeId is required');
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.runtimeId
    ? await runRuntimeDebug(options)
    : await runRuntimeCases(options);
  process.stdout.write(JSON.stringify(result, null, options.pretty ? 2 : 0));
  process.stdout.write('\n');
  const runtimeResults = 'runtimeResults' in result
    ? result.runtimeResults
    : result.cases.flatMap((item) => item.result.runtimeResults);
  const caseFailed = 'cases' in result && result.cases.some((item) => item.status === 'failed');
  const failed = caseFailed || runtimeResults.some((r) => r.status === 'failed');
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
