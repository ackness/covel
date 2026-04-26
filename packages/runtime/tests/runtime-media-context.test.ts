import { describe, expect, it } from 'vitest';
import type { PluginRuntimeUtils } from '@covel/plugin-loader';
import {
  createRuntimeMediaContext,
  type MediaStoreLike,
} from '../src/runtime-media-context.js';

function pngBytes(extra = 0): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...header, ...Array.from({ length: extra }, () => 0)]);
}

function createStore(): MediaStoreLike & {
  readonly puts: Array<{ bytes: Uint8Array | Blob; mime: string; meta: unknown }>;
  readonly ownerships: Array<{ id: string; sessionId: string; pluginId?: string }>;
} {
  const puts: Array<{ bytes: Uint8Array | Blob; mime: string; meta: unknown }> = [];
  const ownerships: Array<{ id: string; sessionId: string; pluginId?: string }> = [];
  return {
    puts,
    ownerships,
    async put(bytes, mime, meta) {
      puts.push({ bytes, mime, meta });
      const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;
      return { id: `media-${puts.length}`, mime, size };
    },
    async get(ref) {
      return new Uint8Array(ref.size);
    },
    async resolveUrl(ref) {
      return `https://media.example.test/${ref.id}`;
    },
    async recordOwnership(id, sessionId, pluginId) {
      ownerships.push({ id, sessionId, ...(pluginId === undefined ? {} : { pluginId }) });
    },
  };
}

const TEST_OWNER = { sessionId: 'sess-test', pluginId: 'plugin-test' } as const;

function createUtils(
  responses: Record<string, Response>,
  blockedUrls: readonly string[] = [],
): PluginRuntimeUtils {
  return {
    validateBaseUrl(url) {
      return blockedUrls.includes(url)
        ? { ok: false, reason: 'blocked by test policy' }
        : { ok: true };
    },
    async fetchWithRetry(input) {
      const url = input.toString();
      const response = responses[url];
      if (!response) throw new Error(`unexpected fetch: ${url}`);
      return response;
    },
  };
}

describe('createRuntimeMediaContext', () => {
  it('forwards put/get/resolveUrl to the media store', async () => {
    const store = createStore();
    const media = createRuntimeMediaContext(store, undefined, TEST_OWNER);
    const ref = await media.put(new Uint8Array([1, 2, 3]), 'application/octet-stream');

    expect(ref).toEqual({ id: 'media-1', mime: 'application/octet-stream', size: 3 });
    expect(await media.get(ref)).toEqual(new Uint8Array(3));
    expect(await media.resolveUrl(ref)).toBe('https://media.example.test/media-1');
    expect(store.ownerships).toEqual([
      { id: 'media-1', sessionId: TEST_OWNER.sessionId, pluginId: TEST_OWNER.pluginId },
    ]);
  });

  it('records ownership after a successful ingestUrl', async () => {
    const store = createStore();
    const utils = createUtils({
      'https://ok.example.test/image': new Response(pngBytes(), {
        headers: { 'content-type': 'image/png' },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    const ref = await media.ingestUrl('https://ok.example.test/image');

    expect(store.puts).toHaveLength(1);
    expect(store.ownerships).toEqual([
      { id: ref.id, sessionId: TEST_OWNER.sessionId, pluginId: TEST_OWNER.pluginId },
    ]);
  });

  it('does not record ownership if ingestUrl fails before put', async () => {
    const store = createStore();
    const utils = createUtils({}, ['https://blocked.example.test/image.png']);
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl('https://blocked.example.test/image.png'),
    ).rejects.toThrow();
    expect(store.puts).toHaveLength(0);
    expect(store.ownerships).toHaveLength(0);
  });

  it('validates the original ingest URL before fetching', async () => {
    const store = createStore();
    const utils = createUtils({}, ['https://blocked.example.test/image.png']);
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(media.ingestUrl('https://blocked.example.test/image.png')).rejects.toThrow(
      /URL rejected/,
    );
    expect(store.puts).toHaveLength(0);
  });

  it('validates redirect targets before following them', async () => {
    const store = createStore();
    const utils = createUtils(
      {
        'https://ok.example.test/start': new Response(null, {
          status: 302,
          headers: { location: 'https://blocked.example.test/image.png' },
        }),
      },
      ['https://blocked.example.test/image.png'],
    );
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(media.ingestUrl('https://ok.example.test/start')).rejects.toThrow(
      /URL rejected/,
    );
    expect(store.puts).toHaveLength(0);
  });

  it('enforces maxBytes while reading the response body', async () => {
    const store = createStore();
    const bytes = pngBytes(32);
    const utils = createUtils({
      'https://ok.example.test/big.png': new Response(bytes, {
        headers: { 'content-type': 'image/png' },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    await expect(
      media.ingestUrl('https://ok.example.test/big.png', { maxBytes: 8 }),
    ).rejects.toThrow(/maxBytes/);
    expect(store.puts).toHaveLength(0);
  });

  it('sniffs MIME from bytes and stores the sniffed value', async () => {
    const store = createStore();
    const utils = createUtils({
      'https://ok.example.test/image': new Response(pngBytes(), {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const media = createRuntimeMediaContext(store, utils, TEST_OWNER);

    const ref = await media.ingestUrl('https://ok.example.test/image', {
      allowedMimes: ['image/png'],
      meta: { source: 'test' },
    });

    expect(ref.mime).toBe('image/png');
    expect(store.puts[0]?.mime).toBe('image/png');
    expect(store.puts[0]?.meta).toMatchObject({
      source: 'test',
      originalUrl: 'https://ok.example.test/image',
    });
  });
});
