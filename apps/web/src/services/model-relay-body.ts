const MAX_CHUNK_BYTES = 256 * 1024;
const CHUNK_INTERVAL_MS = 50;

/** Transfer a response in ordered, bounded relay posts. */
export async function relayResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  postChunk: (bytes: Uint8Array) => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let lastFlush = Date.now();
  const flush = async (): Promise<boolean> => {
    // A prefetched read may already be fulfilled when cancellation arrives.
    // The next reader.read() would reject, but those buffered bytes must not post.
    signal.throwIfAborted();
    if (pendingBytes === 0) return true;
    const bytes = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const part of pending) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    pending = [];
    pendingBytes = 0;
    const accepted = await postChunk(bytes);
    // Start the next batching window after acknowledgement. Counting network
    // latency here turns every already-buffered read into another slow POST.
    lastFlush = Date.now();
    return accepted;
  };
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  for (;;) {
    signal.throwIfAborted();
    reading ??= reader.read();
    let result: ReadableStreamReadResult<Uint8Array> | null;
    if (pendingBytes > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          reading,
          new Promise<null>((resolve) => {
            timer = setTimeout(
              () => resolve(null),
              Math.max(0, CHUNK_INTERVAL_MS - (Date.now() - lastFlush)),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result === null) {
        if (!(await flush())) return false;
        // Retain the same read: starting another would lose the next chunk.
        continue;
      }
    } else result = await reading;
    reading = undefined;
    const { value, done } = result;
    if (done) break;
    for (let start = 0; start < value.byteLength; start += MAX_CHUNK_BYTES) {
      const part = value.subarray(start, start + MAX_CHUNK_BYTES);
      if (
        pendingBytes + part.byteLength > MAX_CHUNK_BYTES &&
        !(await flush())
      ) {
        return false;
      }
      pending.push(part);
      pendingBytes += part.byteLength;
    }
    if (pendingBytes === MAX_CHUNK_BYTES && !(await flush())) {
      return false;
    }
  }
  return flush();
}
