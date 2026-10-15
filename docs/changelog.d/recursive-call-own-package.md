### Breaking

- **`ctx.recursiveCall` rejects targets outside the caller's own plugin package.** Third-party plugins that named another package's runtime must use services for requests and responses, or events to trigger follow-up work. The error identifies the target runtime and caller package before nested execution starts. Bundled and community plugins follow the same rule; see [nested calls](../en/reference/plugins.md#nested-calls-ctxrecursivecall).
