/**
 * Event and message routing types.
 */

export type MessageType = "message" | "event" | "callback";

export interface CovelMessage {
	readonly id: string;
	readonly type: MessageType;
	readonly topic: string;
	readonly payload: Readonly<Record<string, unknown>>;
	/** Optional routing target: `pluginId/runtimeId` */
	readonly targetRuntime?: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly timestamp: string;
}
