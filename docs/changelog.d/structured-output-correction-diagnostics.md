### Changed

- **Structured-output corrections give concrete format feedback.** Runtime corrections explain empty JSON answers and syntax failures with available parser locations. Syntax failures omit misleading schema complaints from salvaged fragments; valid JSON retains its structural diagnostics. Correction budgets stay unchanged and recovery still depends on the model. See [structured output](../en/reference/slots.md#structured-output).
