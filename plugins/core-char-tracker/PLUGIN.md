# core-char-tracker

Analyzes narrative text after each user.input turn to identify newly mentioned characters.
Extracts character names using pattern matching and emits `record.upsert` + `state.patch` proposals to track them.

Runs at post_story phase layer 0 (no dependencies), so story-guide can use the updated character list.
