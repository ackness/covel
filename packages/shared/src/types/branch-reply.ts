export type BranchReplyAction = "createCandidates" | "acceptCandidate";

export interface BranchReplyCandidate {
	readonly id: string;
	readonly index: number;
	readonly text: string;
	readonly source: "deterministic" | "manual" | "llm";
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
