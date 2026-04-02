/**
 * Pure deterministic dice engine.
 * All functions are side-effect-free (except randomness).
 * Randomness is isolated to rollSingleDie() for testability.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface DiceRoll {
  readonly total: number;
  readonly rolls: readonly number[];
  readonly modifier: number;
  readonly expression: string;
}

export interface ParsedExpression {
  readonly count: number;
  readonly sides: number;
  readonly modifier: number;
}

export type CheckOutcome =
  | "critical_success"
  | "success"
  | "failure"
  | "critical_failure";

export interface CheckResult {
  readonly outcome: CheckOutcome;
  readonly roll: DiceRoll;
  readonly dc: number;
  readonly total: number;
  readonly margin: number;
}

export interface PercentageCheckResult {
  readonly outcome: "success" | "failure";
  readonly roll: DiceRoll;
  readonly successRate: number;
  readonly rolled: number;
}

export type DiceSystem = "d20" | "percentage" | "custom";

export interface RollCheckParams {
  readonly skill?: string;
  readonly modifier?: number;
  readonly difficulty?: string;
  readonly system?: DiceSystem;
  readonly expression?: string;
  readonly successRate?: number;
}

// ── Constants ─────────────────────────────────────────────────────

const DIFFICULTY_CLASSES: Readonly<Record<string, number>> = {
  easy: 8,
  medium: 12,
  hard: 16,
  very_hard: 20,
  legendary: 24,
};

// ── Expression Parsing ────────────────────────────────────────────

const DICE_EXPRESSION_RE = /^(\d*)d(\d+)([+-]\d+)?$/i;

/**
 * Parse a dice expression string into structured components.
 * Supports: "2d6+3", "1d20", "d100", "3d8-2"
 */
export function parseExpression(expr: string): ParsedExpression {
  const trimmed = expr.trim();
  const match = DICE_EXPRESSION_RE.exec(trimmed);

  if (!match) {
    throw new Error(`Invalid dice expression: "${expr}"`);
  }

  const count = match[1] ? parseInt(match[1], 10) : 1;
  const sides = parseInt(match[2]!, 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (count < 1 || count > 100) {
    throw new Error(`Dice count must be between 1 and 100, got ${count}`);
  }
  if (sides < 2 || sides > 1000) {
    throw new Error(`Dice sides must be between 2 and 1000, got ${sides}`);
  }

  return { count, sides, modifier };
}

// ── Random Number Generation ──────────────────────────────────────

/**
 * Roll a single die with the given number of sides.
 * Returns an integer in [1, sides].
 * Isolated for testability — can be mocked in tests.
 */
export function rollSingleDie(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

// ── Core Rolling ──────────────────────────────────────────────────

/**
 * Roll dice from an expression string.
 * Returns immutable result with individual rolls and total.
 */
export function rollDice(expression: string): DiceRoll {
  const parsed = parseExpression(expression);
  const rolls: number[] = [];

  for (let i = 0; i < parsed.count; i++) {
    rolls.push(rollSingleDie(parsed.sides));
  }

  const sum = rolls.reduce((acc, val) => acc + val, 0);
  const total = sum + parsed.modifier;

  return Object.freeze({
    total,
    rolls: Object.freeze([...rolls]),
    modifier: parsed.modifier,
    expression,
  });
}

// ── Difficulty Class ──────────────────────────────────────────────

/**
 * Get the numeric difficulty class for a named difficulty level.
 */
export function getDifficultyClass(difficulty: string): number {
  const dc = DIFFICULTY_CLASSES[difficulty];
  if (dc === undefined) {
    throw new Error(
      `Unknown difficulty: "${difficulty}". Valid values: ${Object.keys(DIFFICULTY_CLASSES).join(", ")}`
    );
  }
  return dc;
}

// ── Check Systems ─────────────────────────────────────────────────

/**
 * Determine the outcome of a d20 check.
 * Critical success on natural 20, critical failure on natural 1.
 */
function resolveD20Outcome(
  naturalRoll: number,
  total: number,
  dc: number
): CheckOutcome {
  if (naturalRoll === 20) return "critical_success";
  if (naturalRoll === 1) return "critical_failure";
  return total >= dc ? "success" : "failure";
}

/**
 * Perform a d20 skill check.
 */
function d20Check(modifier: number, difficulty: string): CheckResult {
  const dc = getDifficultyClass(difficulty);
  const naturalRoll = rollSingleDie(20);
  const total = naturalRoll + modifier;
  const outcome = resolveD20Outcome(naturalRoll, total, dc);

  const roll: DiceRoll = Object.freeze({
    total,
    rolls: Object.freeze([naturalRoll]),
    modifier,
    expression: modifier >= 0 ? `1d20+${modifier}` : `1d20${modifier}`,
  });

  return Object.freeze({
    outcome,
    roll,
    dc,
    total,
    margin: total - dc,
  });
}

/**
 * Perform a percentage (d100) check.
 */
function percentageCheck(successRate: number): PercentageCheckResult {
  const clampedRate = Math.max(0, Math.min(100, successRate));
  const rolled = rollSingleDie(100);

  const roll: DiceRoll = Object.freeze({
    total: rolled,
    rolls: Object.freeze([rolled]),
    modifier: 0,
    expression: "1d100",
  });

  return Object.freeze({
    outcome: rolled <= clampedRate ? "success" : "failure",
    roll,
    successRate: clampedRate,
    rolled,
  });
}

/**
 * Perform a custom dice expression check against a DC.
 */
function customCheck(
  expression: string,
  modifier: number,
  difficulty: string
): CheckResult {
  const dc = getDifficultyClass(difficulty);
  const baseRoll = rollDice(expression);
  const total = baseRoll.total + modifier;

  const roll: DiceRoll = Object.freeze({
    total,
    rolls: baseRoll.rolls,
    modifier: baseRoll.modifier + modifier,
    expression,
  });

  return Object.freeze({
    outcome: total >= dc ? "success" : "failure",
    roll,
    dc,
    total,
    margin: total - dc,
  });
}

// ── Unified Check Entry Point ─────────────────────────────────────

/**
 * Perform a skill/ability check using the specified dice system.
 * Returns a unified result that can be used for narrative generation.
 */
export function rollCheck(
  params: RollCheckParams
): CheckResult | PercentageCheckResult {
  const system: DiceSystem = params.system ?? "d20";
  const modifier = params.modifier ?? 0;
  const difficulty = params.difficulty ?? "medium";

  switch (system) {
    case "d20":
      return d20Check(modifier, difficulty);

    case "percentage": {
      const successRate = params.successRate ?? 50;
      return percentageCheck(successRate);
    }

    case "custom": {
      if (!params.expression) {
        throw new Error(
          'Custom dice system requires an "expression" parameter'
        );
      }
      return customCheck(params.expression, modifier, difficulty);
    }

    default:
      throw new Error(`Unknown dice system: "${system}"`);
  }
}
