export type BranchReplyAction = "createCandidates" | "acceptCandidate";

export interface BranchReplyCandidate {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  /**
   * `original` — seeded from / kept as the engine's actual reply (candidate[0]).
   * `regenerated` — a genuine LLM rephrasing produced by the regenerate action.
   * `manual` — supplied verbatim via an explicit `candidates` payload.
   */
  readonly source: "original" | "regenerated" | "manual";
  readonly createdAt: string;
}

export interface BranchReplyTurnRecord {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly baseText: string;
  readonly candidates: readonly BranchReplyCandidate[];
  readonly selectedCandidateId?: string;
  readonly acceptedCandidateId?: string;
  readonly acceptedText?: string;
  readonly status: "ready" | "accepted";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BranchReplyMessageState {
  readonly __turnId: string;
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly status: "ready" | "accepted";
  readonly selectedCandidateId?: string;
  readonly acceptedCandidateId?: string;
  readonly candidates: readonly BranchReplyCandidate[];
  readonly candidateCount: number;
  readonly updatedAt: string;
}

export interface BranchReplyCreateCandidatesPayload {
  readonly action: "createCandidates";
  readonly turnId?: string;
  readonly baseText?: string;
  readonly count?: number;
  readonly candidates?: readonly string[];
  readonly selectedCandidateId?: string;
}

export interface BranchReplyAcceptCandidatePayload {
  readonly action: "acceptCandidate";
  readonly turnId?: string;
  readonly candidateId: string;
  readonly text?: string;
}

export type BranchReplyManualPayload =
  | BranchReplyCreateCandidatesPayload
  | BranchReplyAcceptCandidatePayload;

export type BranchReplyRuntimeResult =
  | {
      // Auto-seed path (no manualPayload): seeds candidate[0] from the active
      // engine's narrative. `seeded: false` on empty / system / already-seeded
      // turns (no proposal emitted).
      readonly action: "seed";
      readonly turnId: string;
      readonly seeded: boolean;
      readonly candidateCount?: number;
    }
  | {
      readonly action: "createCandidates";
      readonly turnId: string;
      readonly candidateCount: number;
      readonly selectedCandidateId?: string;
    }
  | {
      readonly action: "acceptCandidate";
      readonly turnId: string;
      readonly acceptedCandidateId: string;
      readonly acceptedText: string;
    };
