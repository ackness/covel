import { z } from "zod";
import { vocabularyEntries } from "./vocabulary.js";
import { isSuppliedObjectiveAlias } from "./objective-aliases.js";

// Tool-only review, not part of the public WorldIR contract. The model owns
// semantic judgments; this gate checks coverage, provenance and consistency.
export const objectiveAssessmentSchema = z.strictObject({
  quest: z.string().min(1),
  objective: z.string().min(1),
  outcome: z.enum([
    "achieved",
    "planned",
    "partial",
    "failed",
    "unverified",
    "not_addressed",
  ]),
  evidence: z
    .string()
    .describe(
      "Exact contiguous quote from narrative.value supporting this judgment; empty only for not_addressed. Never quote the vocabulary or player intent as proof of completion.",
    ),
});

const keyOf = (quest, objective) => JSON.stringify([quest, objective]);

// Consumers can resolve cosmetic/shortened names. Reject those spellings at
// extraction, including accepted events, so they cannot bypass exact review.
const normalizedName = (name) =>
  name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
function trackedName(name, names) {
  const target = normalizedName(name);
  if (!target) return undefined;
  const exact = names.find((candidate) => normalizedName(candidate) === target);
  if (exact) return exact;
  const matches = names.filter((candidate) => {
    const key = normalizedName(candidate);
    return key.length >= 2 && (key.includes(target) || target.includes(key));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Check the frozen typed inputs, never history, player plans or another store. */
export function objectiveCoverageIssues(facts, assessments, inputSlots) {
  const quests = new Map();
  for (const entry of vocabularyEntries(inputSlots?.vocabulary)) {
    if (entry.type !== "quest") continue;
    const objectives = quests.get(entry.name) ?? new Set();
    for (const objective of entry.details ?? []) objectives.add(objective);
    quests.set(entry.name, objectives);
  }
  const expected = new Set(
    [...quests].flatMap(([quest, objectives]) =>
      [...objectives].map((objective) => keyOf(quest, objective)),
    ),
  );
  const narrative = inputSlots?.narrative;
  const source =
    narrative?.cardinality === "one" && typeof narrative.value === "string"
      ? narrative.value
      : "";
  const issues = [];
  const reviewed = new Map();
  for (const [index, assessment] of (assessments ?? []).entries()) {
    const key = keyOf(assessment.quest, assessment.objective);
    const path = `objectiveAssessments.${index}`;
    if (!expected.has(key))
      issues.push(
        `${path}: copy an open quest name and objective verbatim from vocabulary`,
      );
    if (reviewed.has(key))
      issues.push(`${path}: duplicate objective assessment`);
    reviewed.set(key, assessment);
    if (assessment.outcome === "not_addressed") {
      if (assessment.evidence !== "")
        issues.push(`${path}.evidence: use an empty string for not_addressed`);
    } else if (
      !assessment.evidence.trim() ||
      !source.includes(assessment.evidence)
    ) {
      issues.push(
        `${path}.evidence: quote the exact current narrative text supporting the outcome`,
      );
    }
  }
  for (const key of expected) {
    if (!reviewed.has(key))
      issues.push(`objectiveAssessments: missing assessment for ${key}`);
  }

  const completed = new Set();
  for (const [index, event] of facts.events.entries()) {
    if (event.type !== "quest_change") continue;
    const { quest, status, completedObjectives = [] } = event.attributes;
    const objectives = quests.get(quest);
    const path = `events.${index}.attributes`;
    const canonical = trackedName(quest, [...quests.keys()]);
    if (canonical && canonical !== quest)
      issues.push(
        `${path}.quest: use the exact tracked name ${JSON.stringify(canonical)}`,
      );
    // Vocabulary is bounded context, not an exhaustive ledger. Unlisted
    // quests/objectives (including ones introduced this turn) retain the
    // existing WorldIR rules; they cannot be assessed from absent entries.
    if (!objectives) continue;
    for (const objective of completedObjectives) {
      if (!objectives.has(objective)) {
        if (isSuppliedObjectiveAlias(objective, [...objectives]))
          issues.push(
            `${path}.completedObjectives: use the exact tracked objective from vocabulary, not a paraphrase`,
          );
        continue;
      }
      const key = keyOf(quest, objective);
      if (reviewed.get(key)?.outcome !== "achieved")
        issues.push(
          `${path}.completedObjectives: ${JSON.stringify(objective)} needs an achieved assessment of that exact open objective`,
        );
      completed.add(key);
    }
    if (status === "completed") {
      for (const objective of objectives) {
        if (reviewed.get(keyOf(quest, objective))?.outcome !== "achieved")
          issues.push(
            `${path}.status: cannot complete a quest with an unachieved open objective`,
          );
      }
    }
    if (status === "failed" && completedObjectives.length)
      issues.push(
        `${path}: a failed quest event cannot also finish objectives`,
      );
  }
  for (const [key, assessment] of reviewed) {
    if (
      expected.has(key) &&
      assessment.outcome === "achieved" &&
      !completed.has(key)
    )
      issues.push(
        `events: achieved objective ${key} needs a quest_change with status progressed and its exact completedObjectives text`,
      );
  }
  return issues;
}
