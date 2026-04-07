# Luck Event Notes

This runtime demonstrates a lightweight event plugin.

- It reads player state from another plugin-owned table.
- It writes only to its own table: `demo-plugin.luck_results`.
- It publishes a structured runtime result every time it runs.
- Even when no luck event is applied, the runtime still returns a valid payload.
