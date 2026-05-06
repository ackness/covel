export type BlockSubmission =
	| { kind: "message"; content: string }
	| {
			kind: "trigger_event";
			eventType: string;
			eventData: Record<string, unknown>;
	  };

/**
 * Convert a block submission into either a normal chat message or a custom kernel event.
 *
 * Plugin blocks can declare event-based submission by embedding a JSON payload with:
 *   { _eventType: "some.event.type", ...rest }
 *
 * This removes the need for framework code to know about specific plugin block types.
 */
export function resolveBlockSubmission(
	_blockType: string,
	value: string,
): BlockSubmission {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		// Generic event dispatch: any block can trigger a kernel event
		// by including `_eventType` in its submission payload
		if (typeof parsed._eventType === "string" && parsed._eventType.length > 0) {
			const { _eventType, ...eventData } = parsed;
			return {
				kind: "trigger_event",
				eventType: _eventType,
				eventData,
			};
		}
	} catch {
		// Not valid JSON — treat as normal message
	}

	return { kind: "message", content: value };
}
