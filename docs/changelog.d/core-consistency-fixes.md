### Breaking

- **Embedding hosts must carry event invocation provenance through commit.** `CommitIsolation` now includes `droppedRunIds` and ordered `followerSources`; use `committedEventFollowers` when queuing followers. The topic-based `droppedEmitter` export is removed. See [host commit boundaries](../en/reference/protocol.md).
- **Custom vector adapters must honor query model guards atomically.** `SearchVectorsInput.expectedModelRegistryId`, when provided, must be checked in the same read snapshot as the vector query. See [storage](../en/internals/storage.md).
- **Unused runtime completion exports are removed from `@covel/tools`.** Consumers must drop imports of `runtimeDoneTool`, `isRuntimeDoneSentinel` and `RuntimeDoneSentinel`; the unused `runtime-done` tool is no longer exported.

### Fixed

- **Event consumers follow the payload producer that actually committed.** Another emitter on the same topic cannot keep a consumer or background follower alive after its selected source is dropped. Manual invocations keep their independent behavior. Nested followers survive suspension and queue only on successful resume, and a skipped guard cannot commit nested write-service operations from a dropped source. See [transaction dependencies](../en/reference/transactions.md).
- **Memory queries stay bound to the model that embedded them.** A concurrent model reset falls back to keyword search instead of mixing vector spaces, including models with equal dimensions. See [storage](../en/internals/storage.md).
- **Relationship updates retain earlier edits in the same batch.** Canonical names and aliases resolve to the latest node, and a newly added alias can immediately name an edge endpoint. See [relationships](../en/builtin/world.md#relationships-npc-graph).
- **World editing pauses while a save is pending.** A failed save keeps the draft available for editing and retry. See [world editing](../en/builtin/features.md).
- **Denied interaction approval leaves the card usable.** Players can answer again or abandon an unresolved interaction. See [recovery](../en/builtin/features.md).
- **Custom model connections recognize usable server credentials.** The existing model lookup checks the exact provider, protocol and endpoint through the server registry, including authentication headers, without exposing credentials. See [model lookup](../en/reference/api.md#model-database-model-db).

### Security

- **Job cancellation and retry revalidate authorization under the session lock.** A request waiting on the lock cannot change a same-ID job in a recreated session. See [session writes](../en/internals/security.md).

### Documentation

- **World memory blocks extend the four defaults.** Documentation and the bundled declaration now describe label deduplication and first-definition precedence. See [memory extensions](../en/reference/plugins.md#prompt-and-memory-extensions).
