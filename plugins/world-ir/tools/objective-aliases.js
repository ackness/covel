// Rejection only: these pure text comparisons mirror the existing objective
// merge rules in core-quest/lib/upsert-quests.js. They NEVER infer progress or
// rewrite an objective. Reject any potential supplied-objective alias (including
// ambiguous matches) so the model must use its exact vocabulary text. Unrelated
// unlisted objectives retain the normal WorldIR/consumer contract. Keep parity
// regressions when those consumer comparison rules change.
export function isSuppliedObjectiveAlias(text, objectives) {
  return objectives.some(
    (objective) =>
      normalizeObjectiveText(objective) === normalizeObjectiveText(text) ||
      (containsHan(objective) || containsHan(text)
        ? objectiveSimilarity(
            normalizeObjectiveText(objective),
            normalizeObjectiveText(text),
          )
        : wordSimilarity(objective, text)) > 0,
  );
}

function normalizeObjectiveText(text) {
  const normalized = (text ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  // Leading urgency clauses describe timing rather than objective identity.
  // Keeping them would make two different objectives under the same deadline
  // look more similar than the same action expressed with different detail.
  return normalized
    .replace(/^赶在.{1,12}?前/u, "")
    .replace(/^在.{1,12}?之前/u, "")
    .replace(/^(立即|立刻|尽快|马上)/u, "");
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "before",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "their",
  "to",
  "with",
  "you",
  "your",
]);

function significantWords(text) {
  return new Set(
    (
      (text ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/** Share of the shorter objective's significant words found in the other. */
function wordSimilarity(leftText, rightText) {
  const left = significantWords(leftText);
  const right = significantWords(rightText);
  const shorter = Math.min(left.size, right.size);
  if (shorter < 2) return 0;
  const common = [...left].filter((word) => right.has(word)).length;
  const overlap = common / shorter;
  return common >= 2 && overlap >= 0.6 ? overlap : 0;
}

function objectiveSimilarity(left, right) {
  if (left.length < 4 || right.length < 4) return 0;
  if (hasConflictingMovementIntent(left, right)) return 0;
  const commonSequence = longestCommonSubsequenceLength(left, right);
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const commonBigrams = countCommonBigrams(left, right);
  const sequenceMatch =
    commonSequence >= 4 &&
    commonSequence / shorter >= 0.65 &&
    commonSequence / longer >= 0.4;
  const phraseMatch =
    commonBigrams >= 3 && commonBigrams / Math.max(1, shorter - 1) >= 0.3;

  if (
    (!sequenceMatch && !phraseMatch) ||
    (containsHan(left) &&
      containsHan(right) &&
      countCommonSalientHanCharacters(left, right) < 2)
  ) {
    return 0;
  }

  return (
    commonSequence / shorter +
    commonSequence / longer +
    commonBigrams / Math.max(1, shorter - 1)
  );
}

function hasConflictingMovementIntent(left, right) {
  const entering = ["进入", "潜入", "抵达", "到达"];
  const leaving = ["离开", "撤离", "返回", "逃离"];
  return (
    (entering.some((term) => left.includes(term)) &&
      leaving.some((term) => right.includes(term))) ||
    (leaving.some((term) => left.includes(term)) &&
      entering.some((term) => right.includes(term)))
  );
}

function containsHan(text) {
  return /\p{Script=Han}/u.test(text);
}

function countCommonSalientHanCharacters(left, right) {
  const generic = new Set(
    "进入内部上下前后完成前往到达抵达离开撤退返回并将把从向的了与和",
  );
  const rightCharacters = new Set(
    [...right].filter(
      (character) => containsHan(character) && !generic.has(character),
    ),
  );
  return new Set(
    [...left].filter(
      (character) =>
        containsHan(character) &&
        !generic.has(character) &&
        rightCharacters.has(character),
    ),
  ).size;
}

function longestCommonSubsequenceLength(left, right) {
  const row = new Uint16Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? diagonal + 1
          : Math.max(row[rightIndex], row[rightIndex - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

function countCommonBigrams(left, right) {
  const rightBigrams = new Set();
  for (let index = 0; index < right.length - 1; index += 1) {
    rightBigrams.add(right.slice(index, index + 2));
  }
  const common = new Set();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    if (rightBigrams.has(bigram)) common.add(bigram);
  }
  return common.size;
}
