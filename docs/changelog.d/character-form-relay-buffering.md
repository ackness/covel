### Fixed

- **Opening character template errors are correctable input failures.** Missing field placeholders and invalid defaults return `invalid-input` before publishing a form.
- **Local model relay flushes paused streams and batches after slow acknowledgements.** Buffered bytes no longer wait for the next model chunk, and POST latency no longer forces each buffered read into its own request. Ordering, bounded chunks and backpressure remain enforced. This does not establish the cause of any particular hosted-session delay.
