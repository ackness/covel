### Breaking

- **Static tool policy accepts only `builtin` and `local` sources.** Host integrations must remove the unused `third-party` source and its wildcard rule from their configuration and use the registry’s actual source. Registered community tools are `local`; community server-code and runtime authorization remain separate and unchanged. No stored session data needs rebuilding.
