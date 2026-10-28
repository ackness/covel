### Changed

- **The author SDK requires Node 26.12.1, like the host.** `@covel/plugin-handlers-utils` now declares `engines.node` `>=26.12.1 <27`, the same minimum as the repository, CI and the Docker image, which includes the October 2026 security fixes. Plugin projects on an earlier Node 26 release should move to 26.12.1.
