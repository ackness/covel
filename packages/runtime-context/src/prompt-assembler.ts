import type {
  PromptAssemblyInput,
  PromptAssemblyResult,
  PromptSection,
} from "./types.js";

/**
 * Assemble the final system prompt for a runtime.
 *
 * Order (per design doc):
 *   1. plugin/PLUGIN.md
 *   2. runtime/instructions.md
 *   3. locale directive
 *   4. context sections (sorted by priority desc)
 *   5. tool definitions
 */
export function assemblePrompt(input: PromptAssemblyInput): PromptAssemblyResult {
  const sections: PromptSection[] = [];

  // 1. Plugin-level public prompt
  if (input.pluginPrompt) {
    sections.push({ label: "plugin-prompt", content: input.pluginPrompt });
  }

  // 2. Runtime instructions
  if (input.instructions) {
    sections.push({ label: "instructions", content: input.instructions });
  }

  // 3. Locale directive
  sections.push({
    label: "locale",
    content: `<locale>\nCurrent locale: ${input.locale}\nAll user-facing output MUST be in ${input.locale}.\n</locale>`,
  });

  // 4. Context sections (sorted by priority descending — higher priority first)
  if (input.contextSections && input.contextSections.length > 0) {
    const sorted = [...input.contextSections].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    for (const section of sorted) {
      sections.push({
        label: `context:${section.title}`,
        content: `<context title="${section.title}">\n${section.content}\n</context>`,
      });
    }
  }

  // 5. Tool definitions
  if (input.toolDefinitions && input.toolDefinitions.length > 0) {
    const toolText = input.toolDefinitions
      .map((t) => {
        let entry = `- ${t.qualifiedId}`;
        if (t.description) entry += `: ${t.description}`;
        if (t.inputSchema) entry += `\n  Input: ${JSON.stringify(t.inputSchema)}`;
        return entry;
      })
      .join("\n");
    sections.push({
      label: "tools",
      content: `<available_tools>\n${toolText}\n</available_tools>`,
    });
  }

  const systemPrompt = sections.map((s) => s.content).join("\n\n");
  return { systemPrompt, sections };
}
