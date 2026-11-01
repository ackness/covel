### Changed

- **GPT-6 Chat tool requests use the same reasoning rule through every provider.** Official connections, custom relays, `default`, OpenRouter, and Vercel now send `reasoning_effort: "none"` for the same model and `openai-chat-v1` protocol. Responses retains the selected effort with tools; other model families keep their own reasoning fields. See [thinking strength](../en/reference/slots.md#thinking-strength).
