# Async Image Workflow Shared Rules

This plugin validates a standard async multi-runtime workflow:

1. The frontend renders a button from the plugin-declared action.
2. A click creates an async workflow run.
3. `prompt-optimizer` gathers context and emits a structured image prompt.
4. `image-generator` consumes that structured output as explicit input.
5. Both runtimes must publish their own records.
6. The main UI shows only the final image while prompt details remain in debug / trace.
