### Breaking

- **Plugins can no longer write session-state tables.** `effects.statePatches` and the `state.patch` proposal are removed, along with the `state.changed` and `state.patch.applied` events. Committable results carrying `effects.statePatches` are rejected with guidance to use plugin data (`effects.pluginData`); see the plugin and API references. Recreate old development checkpoints containing `state.patch` proposals or state write baselines. See the kernel state table removal entry for database recreation.
