import type { ProposalItem } from "../types.js";

/**
 * Format a named context section with XML-style tags.
 */
export function formatSection(name: string, content: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = content.replace(new RegExp(`</${escapedName}>`, "g"), `<\\/${name}>`);
  return `<${name}>\n${escaped}\n</${name}>`;
}

/**
 * Format previous runtime outputs for injection into downstream runtime prompts.
 * Includes both the accumulated narrative and all proposals.
 */
export function formatPreviousOutputs(
  narrative: string,
  proposals: ProposalItem[]
): string | null {
  const parts: string[] = [];

  if (narrative) {
    parts.push(`<narrative>\n${narrative}\n</narrative>`);
  }

  // Filter to non-narrative proposals (narrative is already shown above)
  const nonNarrativeProposals = proposals.filter(
    (p) => p.kind !== "narrative.append"
  );

  if (nonNarrativeProposals.length > 0) {
    const proposalLines = nonNarrativeProposals.map((p) => {
      const payload =
        typeof p.payload === "string" ? p.payload : JSON.stringify(p.payload);
      return `- [${p.kind}] ${payload}`;
    });
    parts.push(`<proposals>\n${proposalLines.join("\n")}\n</proposals>`);
  }

  if (parts.length === 0) return null;

  return `<previous_outputs>\n${parts.join("\n\n")}\n</previous_outputs>`;
}
