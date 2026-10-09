import { rankTexts } from "@covel/plugin-handlers-utils";

/** Facts recalled into one story prompt. */
const MAX_RECALLED_FACTS = 5;
/**
 * A fact that answers less of the player's message than this is not recalled.
 * It keeps out a fact that shares only common words with the message.
 */
const MIN_RECALL_COVERAGE = 0.2;
/** Facts of the latest turns are not recalled: the history still shows those turns. */
const RECENT_TURNS = 3;

/** Keys sort by turn, so a list of facts reads in story order. */
export function factKey(turn, index) {
  return `t${String(turn).padStart(5, "0")}-${index + 1}`;
}

/** A fact names its turn, so a reader can tell which of two facts is later. */
export function factText(turn, fact, lang) {
  if (!turn) return fact;
  return lang === "zh" ? `第${turn}回合：${fact}` : `Turn ${turn}: ${fact}`;
}

/**
 * The recorded facts that the player's message is about, in story order.
 * `rows` are the records of the `facts` namespace.
 */
export function recallFacts(rows, playerMessage) {
  if (typeof playerMessage !== "string") return [];
  const facts = rows
    .map((row) => row.value)
    .filter((value) => typeof value?.text === "string" && value.text.trim());
  const latest = Math.max(0, ...facts.map((fact) => fact.turn ?? 0));
  const older = facts.filter(
    (fact) => (fact.turn ?? 0) <= latest - RECENT_TURNS,
  );
  return rankTexts(
    playerMessage,
    older.map((fact) => fact.text),
    { limit: MAX_RECALLED_FACTS, minCoverage: MIN_RECALL_COVERAGE },
  )
    .map(({ index }) => older[index])
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    .map((fact) => fact.text);
}
