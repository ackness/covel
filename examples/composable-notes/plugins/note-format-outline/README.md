# Outline Note

An entry-only provider of `examples/note-format@1`. Its `format-note` service accepts `{ "text": "..." }` with at most 4,000 UTF-16 code units before trimming (whitespace-only input is rejected) and returns nonblank `{ "text": "..." }` with at most 8,000 UTF-16 code units. Every nonblank input line becomes one `- ` bullet. Existing `-`, `*`, `+`, `•`, `‣`, `◦`, and numbered (`1.` or `1)`) prefixes followed by whitespace are replaced with one bullet. For example, `"One\n* Two\n\n3. 三"` becomes `"- One\n- Two\n- 三"`.

The service treats content as plain text. It does not interpret HTML or write caller data. It has no runtime, model, network request, cache, or timer. Run `node --test` in this directory for its standalone formatter tests.
