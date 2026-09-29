/** Provider observations carried separately from generated answer text. */
export interface LLMProviderWarning {
  readonly type: "unsupported" | "compatibility" | "other";
  readonly feature?: string;
  readonly message: string;
}

export type LLMSource =
  | {
      readonly type: "url";
      readonly id: string;
      readonly url: string;
      readonly title?: string;
    }
  | {
      readonly type: "document";
      readonly id: string;
      readonly title?: string;
      readonly fileName?: string;
      readonly documentIndex?: number;
    };

/** Offsets use the provider's original units; absent units are not inferred. */
export interface LLMCitation {
  readonly sourceId: string;
  /** OpenAI annotation spans address the answer; Anthropic spans address the source. */
  readonly location?: "response" | "source";
  readonly citedText?: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly startPage?: number;
  readonly endPage?: number;
  readonly startBlockIndex?: number;
  readonly endBlockIndex?: number;
}

export interface LLMRefusal {
  readonly reason: "refusal" | "content-filter";
  readonly message?: string;
}

export interface LLMDiagnostics {
  readonly warnings?: readonly LLMProviderWarning[];
  readonly sources?: readonly LLMSource[];
  readonly citations?: readonly LLMCitation[];
  /** Explicit refusals are attached to failure diagnostics, never successful output. */
  readonly refusal?: LLMRefusal;
}
