### Fixed

- **Concealed runtime tool calls stay out of turn digests.** Their status remains visible, but their arguments no longer reach digest consumers (F-044).
- **Models no longer receive bookkeeping from character schemas, dimension queries or activation payloads.** Full records remain available to code, and archival search omits UUID source keys (F-045, F-149, F-157).

### Upgrade notes

- **Recreate pending development jobs that froze a turn digest before this fix.** Existing snapshots are not rewritten and may still contain concealed tool arguments.
