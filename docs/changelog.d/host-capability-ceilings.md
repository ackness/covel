### Added

- **Unified L1 host capability ceilings and catalog.** Added `@covel/shared/permissions` (`CAPABILITY_KEYS`, `CAPABILITY_CATALOG`, `resolveEffectiveCapability`, `tightenCapabilityCeiling`), projected deployment capability ceilings in `GET /api/health` under `deployment.capabilities`, and added `COVEL_DISABLED_CAPABILITIES` for downward-only host tightening at startup ([env-registry](../en/reference/env-registry.md), [security](../en/internals/security.md)).

### Security

- **Hard-disabled high-risk capabilities on shared and hosted web deployments.** `browser-private` and `hosted` profiles lock `plugin.providerSource`, `channel.bridge`, `secrets.own`, `net.loopbackCallback`, `net.authProxy`, `plugin.instanceScope`, `compute.sandboxWorker`, `plugin.globalAutoEnable`, `network.localModels`, `app.scheduler`, and `exec.localBridge` to `disabled` at L1 regardless of operator credentials ([security](../en/internals/security.md)).
