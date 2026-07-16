/**
 * Fixed-capacity FIFO ring buffer.
 *
 * `push` is O(1): once full, the newest entry overwrites the oldest via a
 * moving head index (audit R-03 — replaces the previous `array.shift()`
 * trim which was O(n) per overflowing push).
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `RingBuffer capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.items = Array.from<T | undefined>({ length: capacity });
  }

  get size(): number {
    return this.count;
  }

  /** Append an item; when full, the oldest item is overwritten. O(1). */
  push(item: T): void {
    this.items[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Snapshot of current contents, oldest → newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      out.push(this.items[(this.head + i) % this.capacity] as T);
    }
    return out;
  }
}
