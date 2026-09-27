import { DEFAULT_CORE_MEMORY_BLOCKS } from "./blocks.js";

export const DEFINITIONS_CONTRACT = "memory.block-definitions@1";

function validI18n(value) {
  return (
    typeof value === "string" ||
    (value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((text) => typeof text === "string"))
  );
}

function validateDefinitions(value) {
  if (!Array.isArray(value))
    throw new Error("Memory definitions must be an array");
  for (const block of value) {
    if (
      !block ||
      typeof block.label !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(block.label) ||
      !validI18n(block.displayName) ||
      !validI18n(block.extractionHint) ||
      (block.maxChars !== undefined &&
        (!Number.isInteger(block.maxChars) || block.maxChars <= 0))
    ) {
      throw new Error("Invalid memory block definition");
    }
  }
  return value;
}

/** Builtin labels are fixed. Active services and world data may add labels. */
export async function loadDefinitions(ctx) {
  const definitions = new Map(
    DEFAULT_CORE_MEMORY_BLOCKS.map((block) => [block.label, block]),
  );
  const add = (blocks) => {
    for (const block of validateDefinitions(blocks))
      if (!definitions.has(block.label)) definitions.set(block.label, block);
  };
  if (ctx.services) {
    for (const provider of await ctx.services.discover(DEFINITIONS_CONTRACT))
      add(await ctx.services.call({ ...provider, input: {} }));
  }
  const world = await ctx.pluginData.get("definitions", "world");
  if (world !== undefined && world !== null) add(world.blocks);
  return [...definitions.values()];
}
