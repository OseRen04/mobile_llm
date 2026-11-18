import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteModel, getModelStatuses, installModel, verifiedCachedResponse } from '../../packages/model-manager/src/cache';
import { MODEL_CACHE, MODEL_MANIFEST, modelAssetUrl } from '../../packages/model-manager/src/manifest';
import type { ModelKey } from '../../packages/translator-core/src';

const originalManifest = structuredClone(MODEL_MANIFEST);
class MemoryCache {
  entries = new Map<string, Response>();
  match = vi.fn(async (url: string) => this.entries.get(url)?.clone());
  put = vi.fn(async (url: string, response: Response) => { this.entries.set(url, response.clone()); });
  delete = vi.fn(async (url: string) => this.entries.delete(url));
}
let modelCache: MemoryCache;
let estimate: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

async function hash(text: string): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  modelCache = new MemoryCache();
  estimate = vi.fn(async () => ({ usage: 0, quota: 1_000_000 }));
  fetchMock = vi.fn(async () => new Response('abc'));
  vi.stubGlobal('caches', { open: vi.fn(async (name: string) => {
    if (name !== MODEL_CACHE) throw new Error('Unexpected cache');
    return modelCache;
  }) });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', { storage: { estimate } });
  vi.stubGlobal('fetch', fetchMock);
  for (const key of ['toEnglish', 'fromEnglish'] as ModelKey[]) {
    MODEL_MANIFEST[key] = {
      ...originalManifest[key], files: [{ path: 'test.bin', bytes: 3, sha256: await hash('abc') }], totalBytes: 3,
    };
  }
});
afterEach(() => {
  Object.assign(MODEL_MANIFEST, structuredClone(originalManifest));
  vi.unstubAllGlobals();
});

describe('verified model downloads and storage', () => {
  it('commits only exact size and SHA-256 verified bytes, with an accurate final progress', async () => {
    const progress = vi.fn();
    await installModel('toEnglish', progress);
    const url = modelAssetUrl('toEnglish', 'test.bin');
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
    expect(modelCache.put).toHaveBeenCalledTimes(1);
    const saved = await verifiedCachedResponse(url);
    expect(await saved!.text()).toBe('abc');
    expect(saved!.headers.get('x-verified-sha256')).toBe(await hash('abc'));
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    expect((await getModelStatuses()).find((status) => status.key === 'toEnglish'))
      .toMatchObject({ installed: true, state: 'ready', bytes: 3 });
  });

  it.each(['bad', 'ab', 'abcd'])('does not commit a file with bad digest or byte size (%s)', async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    await expect(installModel('toEnglish', vi.fn())).rejects.toThrow();
    expect(modelCache.put).not.toHaveBeenCalled();
    expect((await getModelStatuses()).find((status) => status.key === 'toEnglish')!.installed).toBe(false);
  });

  it('does not report partially installed model assets as ready', async () => {
    MODEL_MANIFEST.toEnglish.files.push({ path: 'second.bin', bytes: 3, sha256: await hash('abc') });
    MODEL_MANIFEST.toEnglish.totalBytes = 6;
    fetchMock.mockResolvedValueOnce(new Response('abc')).mockResolvedValueOnce(new Response('bad'));
    await expect(installModel('toEnglish', vi.fn())).rejects.toThrow();
    expect(modelCache.put).toHaveBeenCalledTimes(1);
    expect((await getModelStatuses()).find((status) => status.key === 'toEnglish'))
      .toMatchObject({ installed: false, state: 'partial', bytes: 3, totalBytes: 6 });
  });

  it('reuses a verified completed file and repairs invalid metadata', async () => {
    await installModel('toEnglish', vi.fn());
    fetchMock.mockClear();
    await installModel('toEnglish', vi.fn());
    expect(fetchMock).not.toHaveBeenCalled();
    const url = modelAssetUrl('toEnglish', 'test.bin');
    modelCache.entries.set(url, new Response('abc', { headers: { 'content-length': '3', 'x-verified-sha256': 'bad' } }));
    expect((await getModelStatuses()).find((status) => status.key === 'toEnglish')!.state).toBe('corrupt');
    expect(await verifiedCachedResponse(url)).toBeUndefined();
    await installModel('toEnglish', vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects insufficient storage before making a download request', async () => {
    estimate.mockResolvedValue({ usage: 100, quota: 101 });
    await expect(installModel('toEnglish', vi.fn())).rejects.toThrow('空き容量');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelCache.put).not.toHaveBeenCalled();
  });

  it('cancels before fetching when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(installModel('toEnglish', vi.fn(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelCache.put).not.toHaveBeenCalled();
  });

  it('cancels an active response stream without saving its incomplete bytes', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        controller.abort();
        stream.enqueue(new TextEncoder().encode('a'));
      }, cancel,
    }, { highWaterMark: 0 });
    fetchMock.mockResolvedValue(new Response(body));
    await expect(installModel('toEnglish', vi.fn(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
    expect(modelCache.put).not.toHaveBeenCalled();
  });

  it('deletes only the requested model and rejects unlisted asset URLs', async () => {
    await installModel('toEnglish', vi.fn());
    await installModel('fromEnglish', vi.fn());
    const other = modelAssetUrl('fromEnglish', 'test.bin');
    modelCache.entries.set('https://unrelated.example/asset', new Response('Unrelated'));
    await deleteModel('toEnglish');
    expect(modelCache.entries.has(modelAssetUrl('toEnglish', 'test.bin'))).toBe(false);
    expect(modelCache.entries.has(other)).toBe(true);
    expect(modelCache.entries.has('https://unrelated.example/asset')).toBe(true);
    expect(await verifiedCachedResponse('https://unrelated.example/asset')).toBeUndefined();
    expect(() => modelAssetUrl('toEnglish', 'unlisted.bin')).toThrow('Unlisted');
  });
});
