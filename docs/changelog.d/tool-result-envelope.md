### Breaking

- **Tools use an explicit model view and a new error JSON contract.** `_text` is no longer special; use `withModelView`. Failures render as `{error:{code,message,hint?}}` with the SDK's fixed error codes. Hooks parsing `result.result` must follow this shape. `ctx.tools.call` rejects with `ToolError`; `ToolValidationError.code` is `invalid-input`. `queryDimensionSnapshot` returns `{results,text}`. No development data needs to be recreated; stored tool text and suspended transcripts remain readable.

### Added

- **Tool authors can choose model-visible content and coded errors.** The public SDK exports `withModelView`, `getModelView`, `ToolError`, `isToolError` and `TOOL_ERROR_CODES`.
- **Staged writes carry a localized notice.** Successful calls with proposals or events report their count, kinds and a reminder that they take effect at turn end and may still be rejected.

### Changed

- **Builtin tools and delegate use one model-facing envelope.** Code-facing content, UI payloads and refusal accounting keep their existing roles. Pending-only scoped plugin-data reads omit timestamps; stored rows keep their creation and update times.
- **Unexpected tool errors expose only a shortened first line to the model.** UUIDs become `<id>`, while non-concealed traces and server logs retain the full error for diagnosis.
