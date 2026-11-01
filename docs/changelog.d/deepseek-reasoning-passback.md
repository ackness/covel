### Fixed

- **DeepSeek thinking continuations keep the reasoning field after text-only answers.** OpenAI Chat uses model-family capability data to include empty reasoning on every assistant step in the current user turn, preventing missing-`reasoning_content` errors during answer repair or steering. Other model families keep their request format. See [thinking strength](../en/reference/slots.md#thinking-strength).
