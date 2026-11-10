### Fixed

- **Default story providers remain available until plugin selection stabilizes.** Overlapping default replacements and conflicts can no longer remove every story provider when a replacement subsequently loses its required contract. Dependent plugins can use a retained default. See [framework contracts](../reference/plugins.md#framework-contracts).
- **Nested stories cannot release paid presentation work.** Story messages retain kernel-owned call identity through suspension release and selector recovery, including when the same runtime also runs at top level. See [presentation runtimes](../reference/plugins.md#presentation-runtimes).

### Upgrade notes

- **Recreate development story sources captured before call receipts.** Old story messages and presentation jobs must not be reused as recovery sources; start a new development session. The host does not infer call identity from old data.
