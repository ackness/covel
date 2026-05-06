/**
 * UI component types for LLM-driven rendering.
 */

export type UIComponentType =
	| "stat-bar"
	| "card"
	| "choice-list"
	| "image"
	| "table"
	| "notification"
	| "dialog"
	| "inventory"
	| "map-marker"
	| "progress";

export type UIPartStatus =
	| "pending"
	| "streaming"
	| "success"
	| "error"
	| "paused";

export type UIRenderLayout = "stream" | "split" | "overlay";

export interface UIRenderPartRetry {
	readonly count: number;
	readonly lastError?: string;
}

export interface UIRenderPart {
	/** Stable identifier for fine-grained status updates across re-renders. */
	readonly id: string;
	readonly type: UIComponentType | string;
	readonly status: UIPartStatus;
	readonly content: unknown;
	readonly retry?: UIRenderPartRetry;
}

export interface UIRenderPartsInstruction {
	readonly parts: readonly UIRenderPart[];
	readonly layout?: UIRenderLayout;
	/** Aggregate status derived by producers or consumers from `parts`. */
	readonly status?: UIPartStatus;
}

export interface UIRenderLegacyInstruction {
	readonly type: UIComponentType | string;
	readonly [key: string]: unknown;
}

export type UIRenderInstruction =
	| UIRenderPartsInstruction
	| UIRenderLegacyInstruction;

export function isUIRenderPartsInstruction(
	value: unknown,
): value is UIRenderPartsInstruction {
	return (
		!!value &&
		typeof value === "object" &&
		Array.isArray((value as { parts?: unknown }).parts)
	);
}

function normalizePartStatus(value: unknown): UIPartStatus {
	return value === "pending" ||
		value === "streaming" ||
		value === "success" ||
		value === "error" ||
		value === "paused"
		? value
		: "success";
}

function inferInstructionStatus(parts: readonly UIRenderPart[]): UIPartStatus {
	if (parts.some((part) => part.status === "error")) return "error";
	if (parts.some((part) => part.status === "paused")) return "paused";
	if (parts.some((part) => part.status === "streaming")) return "streaming";
	if (parts.some((part) => part.status === "pending")) return "pending";
	return "success";
}

export function normalizeUIRenderInstruction(
	instruction: UIRenderInstruction,
	fallbackId = "ui-1",
): UIRenderPartsInstruction {
	if (isUIRenderPartsInstruction(instruction)) {
		const parts = instruction.parts.map((rawPart, index) => {
			const part = rawPart as unknown as Record<string, unknown>;
			return {
				id:
					typeof part.id === "string" && part.id.length > 0
						? part.id
						: `${fallbackId}-part-${index + 1}`,
				type:
					typeof part.type === "string" && part.type.length > 0
						? part.type
						: "card",
				status: normalizePartStatus(part.status),
				content: "content" in part ? part.content : {},
				...(part.retry && typeof part.retry === "object"
					? { retry: part.retry as UIRenderPartRetry }
					: {}),
			};
		});
		return {
			parts,
			...(instruction.layout ? { layout: instruction.layout } : {}),
			status: normalizePartStatus(
				instruction.status ?? inferInstructionStatus(parts),
			),
		};
	}

	const legacy = instruction as UIRenderLegacyInstruction;
	const id =
		typeof legacy.id === "string" && legacy.id.length > 0
			? legacy.id
			: fallbackId;
	const content: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(legacy)) {
		if (key !== "id" && key !== "type") content[key] = value;
	}
	const part: UIRenderPart = {
		id,
		type:
			typeof legacy.type === "string" && legacy.type.length > 0
				? legacy.type
				: "card",
		status: "success",
		content,
	};
	return {
		parts: [part],
		status: "success",
	};
}

/**
 * JSON Schema-based block schema declaration for plugin UI rendering.
 */
export interface BlockSchemaMeta {
	/** Human-readable display name (string or locale-keyed). */
	readonly displayName?: string | Record<string, string>;
	readonly [key: string]: unknown;
}

export interface BlockSchemaDeclaration {
	/** Block type identifier (matches UIComponentType or custom). */
	readonly blockType: string;
	/** Human-readable display name. */
	readonly displayName?: string;
	/** JSON Schema describing the block's data shape. */
	readonly dataSchema: {
		readonly type: string;
		readonly properties?: Record<string, unknown>;
		readonly required?: readonly string[];
		readonly [key: string]: unknown;
	};
	/** Whether the block accepts user input (form submission). */
	readonly interactive?: boolean;
	/** JSON Schema for form submission payload (interactive blocks). */
	readonly submitSchema?: {
		readonly type: string;
		readonly properties?: Record<string, unknown>;
		readonly required?: readonly string[];
		readonly [key: string]: unknown;
	};
	/** Block metadata (display name, description, etc.). */
	readonly meta: BlockSchemaMeta;
}
