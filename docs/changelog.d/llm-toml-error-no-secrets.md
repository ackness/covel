### Security

- **A broken `llm.toml` no longer prints environment variable values.** When a line with `${VAR}` had a syntax error (for example `apiKey = ${DEEPSEEK_API_KEY}` without quotes), the error quoted the text with the key already filled in, and it reached `server.log`, the Settings page and the `PUT /api/config/raw/llm.toml` response. The error now gives only the line, the column and the reason.
