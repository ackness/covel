### Fixed

- **The story narrator works again on OpenAI's Responses protocol.** Structured output requests now send `strict: false`. Without it, OpenAI treated the schema as strict and rejected the segmented story schema with HTTP 400, so every narrator turn failed before any text was written.
