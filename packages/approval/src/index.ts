export {
	createApprovalPipeline,
	matchPermissionRule,
} from "./approval-pipeline.js";
export type {
	ApprovalPipeline,
	ApprovalCheckResult,
	PermissionRule,
} from "./approval-pipeline.js";

// PR-7: Plugin RPC approval gate
export { createRpcApprovalGate } from "./rpc-approval.js";
export type {
	RpcApprovalGate,
	EvaluateInput,
	EvaluateResult,
} from "./rpc-approval.js";
