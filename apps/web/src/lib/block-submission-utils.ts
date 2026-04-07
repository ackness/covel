export type BlockSubmission =
  | { kind: "message"; content: string }
  | { kind: "trigger_event"; eventType: string; eventData: Record<string, unknown> };

/**
 * Convert a block submission into either a normal chat message or a custom kernel event.
 */
export function resolveBlockSubmission(
  blockType: string,
  value: string,
): BlockSubmission {
  if (blockType === "core_image_settings") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (
        parsed.type === "core_image_settings.update" &&
        parsed.settings &&
        typeof parsed.settings === "object"
      ) {
        return {
          kind: "trigger_event",
          eventType: "image.settings.updated",
          eventData: {
            settings: parsed.settings as Record<string, unknown>,
          },
        };
      }
    } catch {
      // Fall through to normal message handling.
    }
  }

  return { kind: "message", content: value };
}
