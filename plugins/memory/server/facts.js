import { rankTexts, searchTerms } from "@covel/plugin-handlers-utils";

/** Facts recalled into one story prompt. */
const MAX_RECALLED_FACTS = 5;
/**
 * A fact that answers less of the player's message than this is not recalled.
 * It keeps out a fact that shares only common words with the message.
 */
const MIN_RECALL_COVERAGE = 0.2;
/**
 * The part of the message's terms a fact must hold. One everyday word that a
 * long message shares with a fact ("look for", "ask about") is below it.
 */
const MIN_MESSAGE_PART = 0.15;
/** Facts of the latest turns are not recalled: the history still shows those turns. */
const RECENT_TURNS = 3;
/** A new fact that shares this much of its terms with a recorded fact repeats it. */
const REPEAT_OVERLAP = 0.7;
/** Recorded facts shown to the model so that it does not write them again. */
const RECENT_FACTS_SHOWN = 8;

/** Keys sort by turn, so a list of facts reads in story order. */
export function factKey(turn, index) {
  return `t${String(turn).padStart(5, "0")}-${index + 1}`;
}

/** A fact names its turn, so a reader can tell which of two facts is later. */
export function factText(turn, fact, lang) {
  if (!turn) return fact;
  return lang === "zh" ? `第${turn}回合：${fact}` : `Turn ${turn}: ${fact}`;
}

/** The fact without the turn that `factText` put in front. */
function factBody(text) {
  return text.replace(/^(?:第\d+回合：|Turn \d+: )/, "");
}

function recordedFacts(rows) {
  return rows
    .map((row) => row.value)
    .filter((value) => typeof value?.text === "string" && value.text.trim())
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
}

/** The latest recorded facts, oldest first, for the extraction prompt. */
export function recentFacts(rows) {
  return recordedFacts(rows)
    .slice(-RECENT_FACTS_SHOWN)
    .map((fact) => fact.text);
}

/**
 * The new facts that no recorded fact and no earlier new fact already says.
 * Two facts repeat each other when the shorter one shares most of its terms
 * with the other; a model often writes the same event again on the next turn.
 */
export function withoutRepeats(newFacts, rows) {
  const known = recordedFacts(rows).map(
    (fact) => new Set(searchTerms(factBody(fact.text))),
  );
  const kept = [];
  for (const fact of newFacts) {
    const terms = new Set(searchTerms(fact));
    const repeats = known.some((other) => {
      let shared = 0;
      for (const term of terms) if (other.has(term)) shared++;
      return (
        shared / Math.max(1, Math.min(terms.size, other.size)) >= REPEAT_OVERLAP
      );
    });
    if (repeats) continue;
    kept.push(fact);
    known.push(terms);
  }
  return kept;
}

/**
 * The recorded facts that the player's message is about, in story order.
 * `rows` are the records of the `facts` namespace; `names` are the names of
 * the characters the story knows.
 *
 * A fact is recalled when a fair part of the message is about it, or when the
 * message and the fact name the same character. Sharing one everyday word is
 * not enough, and a long message that names someone still finds their facts.
 */
export function recallFacts(rows, playerMessage, names = []) {
  if (typeof playerMessage !== "string") return [];
  const facts = recordedFacts(rows);
  const latest = Math.max(0, ...facts.map((fact) => fact.turn ?? 0));
  const older = facts.filter(
    (fact) => (fact.turn ?? 0) <= latest - RECENT_TURNS,
  );
  const messageTerms = searchTerms(playerMessage);
  // A player writes part of a name ("Mira" for "Mira Voss"), so the terms of
  // the names are compared, not the whole names.
  const nameTerms = new Set(
    names
      .filter((name) => typeof name === "string")
      .flatMap((name) => searchTerms(name)),
  );
  const named = messageTerms.filter((term) => nameTerms.has(term));
  return rankTexts(
    playerMessage,
    older.map((fact) => fact.text),
    { minCoverage: MIN_RECALL_COVERAGE },
  )
    .filter(({ index, matched }) => {
      if (matched / messageTerms.length >= MIN_MESSAGE_PART) return true;
      if (named.length === 0) return false;
      const factTerms = new Set(searchTerms(older[index].text));
      return named.some((term) => factTerms.has(term));
    })
    .slice(0, MAX_RECALLED_FACTS)
    .map(({ index }) => older[index])
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    .map((fact) => fact.text);
}
