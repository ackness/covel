### Fixed

- **The story narrator works on OpenAI's Responses protocol.** Structured output requests now send `strict: false`. Without it, OpenAI treated the schema as strict and rejected the narrator's output schema with HTTP 400, so narrator turns failed before any text was written.
- **OpenAI's own Chat API accepts Covel's tool calls on GPT-6 models.** That endpoint rejects function tools unless reasoning is `none`, including when no level is chosen. Requests with tools on an `openai` slot over `openai-chat-v1` now send `reasoning_effort: "none"`; requests without tools keep the chosen level. The server logs a warning at load for each affected slot. Use `openai-responses-v1` to keep reasoning with tools.
- **GPT-6 no longer offers a `minimal` reasoning level**, which OpenAI rejects; on OpenAI's own Chat API the levels stop at `xhigh`.
