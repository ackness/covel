### Added

- **Plugin Platform v2 (`apiVersion: 2`, `scope: instance | both`) primitives.** Added lazy `activationEvents`, package-isolated `covel.secrets` and `covel.instanceData`, `covel.sandbox`, `registerAppAction` (`POST /api/plugins/:pluginId/actions/:action`, `GET /api/plugins/:pluginId/instance-data/:namespace`), multi-step Config Flows (`POST /api/plugins/:pluginId/flows/:flowId/start`, runs/step/cancel with `openPluginConfigFlow` UI wizard), read-only `appEvents` + bounded `schedules`, `channel.bridge@1`, four-pass prompt governance with cross-plugin fact predicates, instance UI slots (`settingsSection`, `appPage`, `topbarStatus`), and session micro UI slots (`composerAction`, `messageAction`, `messageBelow`, `window`) ([Plugins](../reference/plugins.md), [Extension points](../reference/extension-points.md), [UI panels](../reference/ui-panels.md)).
- **Plugin-managed model provider sources (`provider.source@1`).** Added `contributes.providerSources` and `covel.registerProviderSources` backed by `GET /api/provider-sources`, `GET /api/provider-sources/:pluginId/:sourceId/usage`, `source`/`account` bindings in presets, slots, `POST /api/ai/models`, `POST /api/ai/ping`, and `GET /api/model-db/lookup?credentials=1`, gateway single-flight `401` token refresh, multi-account `429`/auth failover, `requestShape` (`openai-responses` `instructions`, `store: false`, `forceStream` SSE aggregation, parameter omissions), mode gating, dormant boot without stored credentials, and web Settings controls ([Slots](../reference/slots.md), [HTTP API](../reference/api.md)).

### Security

- **Server-only encrypted secret storage and strict provider-source isolation.** Added host `SecretVault` (`secrets.own`), ephemeral state-verified localhost OAuth callbacks (`net.loopbackCallback`), bounded proxy gating (`net.authProxy`), and `permissions.http` origin locking for `provider.source@1` endpoints; provider source tokens remain server-side and are omitted from `X-Provider-Keys`, web responses, traces, and error messages ([Security](../internals/security.md), [Plugin installation](../reference/plugin-installation.md)).

### Fixed

- Approved third-party provider sources can use a text wire registered by their own package in model presets, connection tests, and sessions. Unpinned presets try ready accounts in default-first order.
- Responses sources can append a custom endpoint path to their base URL. Local OAuth callbacks accept IPv6 loopback connections where available.
- Config Flow callbacks recheck permissions and OAuth state on both browser return and manual paste. Closing a wizard during startup cancels its run when the host responds.
- RPC policy failures deny cached grants, timed-out scheduled handlers retain their overlap guard, and memory-backed instance data reads return isolated values.
