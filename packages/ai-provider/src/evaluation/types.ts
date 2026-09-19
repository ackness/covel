import type { UsageSummary } from "../types.js";

export type EvaluationJson =
  | string
  | number
  | boolean
  | null
  | readonly EvaluationJson[]
  | { readonly [key: string]: EvaluationJson };

/** Shared state and rubrics are data, not chat messages or generation prompts. */
export type EvaluationValue =
  | string
  | null
  | readonly EvaluationJson[]
  | { readonly [key: string]: EvaluationJson };

export type EvaluationQuestion =
  | {
      readonly type: "boolean";
      readonly instructions?: EvaluationValue;
      readonly criteria?: {
        readonly true?: EvaluationValue;
        readonly false?: EvaluationValue;
      };
    }
  | {
      readonly type: "choice";
      readonly instructions?: EvaluationValue;
      readonly criteria: Readonly<Record<string, EvaluationValue>>;
    }
  | {
      readonly type: "score";
      readonly instructions?: EvaluationValue;
      readonly criteria: readonly EvaluationValue[];
    };

export type EvaluationQuestions = Readonly<Record<string, EvaluationQuestion>>;

export type EvaluationAnswer<
  Q extends EvaluationQuestion = EvaluationQuestion,
> = Q extends { type: "boolean" }
  ? { type: "boolean"; probability: number }
  : Q extends { type: "choice"; criteria: infer C }
    ? {
        type: "choice";
        choice: keyof C & string;
        probabilities: Record<keyof C & string, number>;
      }
    : { type: "score"; score: number; probabilities: Record<string, number> };

export interface EvaluationParams<
  Q extends EvaluationQuestions = EvaluationQuestions,
> {
  model: string;
  state: EvaluationValue;
  questions: Q;
}

export interface EvaluationResult<
  Q extends EvaluationQuestions = EvaluationQuestions,
> {
  /** Actual provider-reported model version, preserving resolved aliases. */
  model: string;
  answers: { [K in keyof Q]: EvaluationAnswer<Q[K]> };
  usage: UsageSummary;
  /** Provider statistics have no cross-provider calibration guarantee. */
  providerMetadata?: Record<string, unknown>;
}
