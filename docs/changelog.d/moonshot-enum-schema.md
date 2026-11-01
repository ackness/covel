### Changed

- **Event tools describe typed payloads for strict model endpoints, including Kimi/Moonshot.** Session event tools add inferred types to their model-facing schema copies. Topics that cannot be described safely are omitted with a server warning, so an optional event schema does not block the story. Author schemas still control payload validation. See [`emit-event`](../en/reference/tools.md#emit-event).
