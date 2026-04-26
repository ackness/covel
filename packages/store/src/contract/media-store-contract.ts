import { describe, expect, it } from 'vitest';
import { mediaRefSchema } from '@covel/shared';
import type { MediaStore } from '../media-store.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const OTHER = new Uint8Array([1, 2, 3, 4]);

async function toUint8Array(value: Uint8Array | Blob): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(await value.arrayBuffer());
}

export function runMediaStoreContractTests(
  name: string,
  createStore: () => MediaStore | Promise<MediaStore>,
): void {
  describe(`MediaStore Contract: ${name}`, () => {
    it('stores bytes as a MediaRef and reads them back', async () => {
      const store = await createStore();
      const ref = await store.put(PNG, 'image/png', { width: 1, height: 1 });

      expect(mediaRefSchema.parse(ref)).toEqual(ref);
      expect(ref.mime).toBe('image/png');
      expect(ref.size).toBe(PNG.byteLength);
      expect(ref.meta).toEqual({ width: 1, height: 1 });
      expect(await store.exists(ref.id)).toBe(true);

      const bytes = await toUint8Array(await store.get(ref));
      expect([...bytes]).toEqual([...PNG]);
    });

    it('deduplicates identical content by sha256 id', async () => {
      const store = await createStore();

      const a = await store.put(PNG, 'image/png');
      const b = await store.put(PNG, 'image/png');
      const c = await store.put(OTHER, 'application/octet-stream');

      expect(a.id).toBe(b.id);
      expect(a.id).not.toBe(c.id);
    });

    it('resolves a readable URL for stored media', async () => {
      const store = await createStore();
      const ref = await store.put(PNG, 'image/png');

      const url = await store.resolveUrl(ref);
      expect(url).toMatch(/^(memory:\/\/media\/|file:\/\/)/);
      expect(url).toContain(ref.id);
    });

    it('prefers a MediaRef url when provided', async () => {
      const store = await createStore();
      const ref = await store.put(PNG, 'image/png');
      const url = 'https://example.test/signed';

      await expect(store.resolveUrl({ ...ref, url })).resolves.toBe(url);
    });

    it('deletes stored media by id', async () => {
      const store = await createStore();
      const ref = await store.put(PNG, 'image/png');

      await store.delete(ref.id);

      expect(await store.exists(ref.id)).toBe(false);
      await expect(store.get(ref)).rejects.toThrow(ref.id);
    });
  });
}
