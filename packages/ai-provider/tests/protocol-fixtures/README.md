# Synthetic provider protocol fixtures

These fixtures are hand-authored examples, not captured requests or responses.
All model, call, file, and document identifiers are synthetic. Each JSON file
records the pinned Vercel AI SDK implementation used to check the corresponding
annotation and streaming shapes.

- `success` and `stream` describe the same text, tool arguments, and citations.
- `refusal` and `refusalStream` cover explicit provider refusal, including text
  delivered before a refusal is known.
- `unknown_field`, the Responses future event, and top-level `warnings` model
  compatible-provider extensions. They are not claims that the native APIs emit
  these fields. Warnings are normalized only when an extension reports them.

The test splits SSE at byte boundaries and checks normalized values, fragmented
tool arguments, citation identity, and terminal refusal behavior. Passing these
fixtures does not replace validation against a live provider.
