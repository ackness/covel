### Fixed

- **Browser-private saves retain default dependencies and world starting content.** The first sync downloads the server's complete initialized state instead of overwriting it with an empty local seed. Quests, inventory, affinity, codex, and relationship features keep their required providers and starting data. Established saves keep their own selection and progress when the server restarts.

### Upgrade notes

- **Create a new browser test save to verify starting content.** Existing development saves are not reseeded automatically; their progress remains authoritative. A missing dependency can still be enabled from its in-game notice.
