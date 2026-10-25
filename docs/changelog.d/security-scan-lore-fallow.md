### Security

- **Malformed narrator-only comments no longer cause quadratic parsing time.** Repeated marker mentions in world lore are scanned without repeated suffix backtracking, preserving existing spoiler-hiding behavior.
- **Fallow is updated to 3.34.0.** The development analyzer fixes out-of-root config reads and path probes when analyzing untrusted repository content.
