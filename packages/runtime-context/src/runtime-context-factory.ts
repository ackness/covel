import type { RuntimeContext, RuntimeContextFactoryInput } from "./types.js";
import { assemblePrompt } from "./prompt-assembler.js";

/**
 * Create a RuntimeContext for a single runtime execution.
 */
export function createRuntimeContext(input: RuntimeContextFactoryInput): RuntimeContext {
  const prompt = assemblePrompt(input.promptInput);

  return {
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    locale: input.locale,
    prompt,
    settings: input.settings,
    logger: input.logger,
    bus: input.bus,
    records: input.records,
    tables: input.tables,
    tools: input.tools,
    scripts: input.scripts,
    references: input.references,
    approvals: input.approvals,
  };
}
