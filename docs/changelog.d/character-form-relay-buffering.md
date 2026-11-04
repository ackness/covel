### Fixed

- **Opening character template errors are correctable input failures.** Missing field placeholders and invalid defaults return `invalid-input` before publishing a form.
- **The local model relay flushes paused streams, batches after slow acknowledgements and stops on cancellation.** Buffered bytes no longer wait for the next model chunk, and POST latency no longer forces each buffered read into its own request. If cancellation arrives while a chunk POST awaits acknowledgement, an already-read next chunk is discarded and no end marker is sent. Ordering, bounded chunks and backpressure remain enforced.
