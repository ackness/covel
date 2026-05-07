export type LivingWorldRuleKind = "constant" | "triggered" | "evolving";
export type LivingWorldRuleCategory =
  | "character"
  | "scene"
  | "relationship"
  | "world"
  | "style";
export type LivingWorldRulePosition =
  | "before_plugin"
  | "after_plugin"
  | "at_depth";
export type LivingWorldRuleBudgetClass = "sticky" | "flexible" | "droppable";

export interface LivingWorldRuleCoordinate {
  readonly position: LivingWorldRulePosition;
  readonly depth?: number;
}

export interface LivingWorldRuleOwner {
  readonly pluginId?: string;
  readonly characterId?: string;
}

export interface LivingWorldRule {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly kind?: LivingWorldRuleKind;
  readonly category?: LivingWorldRuleCategory;
  readonly keys?: readonly string[];
  readonly enabled?: boolean;
  readonly coordinate?: LivingWorldRuleCoordinate;
  readonly insertionOrder?: number;
  readonly budgetClass?: LivingWorldRuleBudgetClass;
  readonly owner?: LivingWorldRuleOwner;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LivingWorldRuleRecord {
  readonly rule: LivingWorldRule;
  readonly lorebookEntryId: string;
  readonly updatedAt: string;
}

export interface LivingWorldRuleSavePayload {
  readonly rule?: LivingWorldRule;
  readonly ruleJson?: string;
}

export interface LivingWorldRuleSaveResult {
  readonly saved: boolean;
  readonly ruleId: string;
  readonly lorebookEntryId: string;
}
