### Security

- **Bundled plugins follow `permissions.http` too.** Every package's runtime `ctx.utils`, `ctx.media.ingestUrl`, entry `covel.http` and service or extension `context.utils` reach only the origins and methods its `PLUGIN.md` declares, whatever the package's source. Bundled packages used to skip this check. No bundled plugin sends HTTP requests today; a fork that adds one must declare its origins.
