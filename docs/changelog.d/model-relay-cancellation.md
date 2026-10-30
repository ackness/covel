### Fixed

- **Cancelled model relay transfers stop before sending prefetched bytes.** If cancellation arrives while a chunk POST awaits acknowledgement, an already-read next chunk is discarded and no end marker is sent. Ordered transfers, bounded chunks and backpressure are preserved.
