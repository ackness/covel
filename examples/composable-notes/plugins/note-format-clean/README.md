# Clean Note

An entry-only provider of `examples/note-format@1`. Its `format-note` service accepts `{ "text": "..." }` with at most 4,000 UTF-16 code units before trimming (whitespace-only input is rejected) and returns nonblank `{ "text": "..." }` with at most 8,000 UTF-16 code units. It normalizes CRLF and CR to LF, trims each line, and reduces multiple empty lines to one. For example, `"  One  \r\n\r\n\r\n Two "` becomes `"One\n\nTwo"`.

The service treats content as plain text. It does not interpret HTML or write caller data. It has no runtime, model, network request, cache, or timer. Run `node --test` in this directory for its standalone formatter tests.
