import type { ModelKey } from '../../translator-core/src';
import { MODEL_CACHE, MODEL_MANIFEST, modelAssetUrl } from './manifest';

export interface ModelStatus {
  key: ModelKey;
  installed: boolean;
  bytes: number;
  totalBytes: number;
  label: string;
  state: 'missing' | 'partial' | 'ready' | 'corrupt';
}

function requireCache(): void {
  if (!globalThis.caches || !globalThis.crypto?.subtle) {
    throw new Error('この環境ではモデルを安全に保存できません。HTTPS または localhost で、Cache Storage 対応ブラウザを使用してください。');
  }
}

export async function getModelStatuses(): Promise<ModelStatus[]> {
  requireCache();
  const cache = await caches.open(MODEL_CACHE);
  return Promise.all((Object.keys(MODEL_MANIFEST) as ModelKey[]).map(async key => {
    const model = MODEL_MANIFEST[key];
    let bytes = 0;
    let present = 0;
    let corrupt = false;
    for (const file of model.files) {
      const response = await cache.match(modelAssetUrl(key, file.path));
      if (!response) continue;
      present++;
      if (response.headers.get('x-verified-sha256') !== file.sha256 || Number(response.headers.get('content-length')) !== file.bytes) {
        corrupt = true;
      } else bytes += file.bytes;
    }
    const installed = present === model.files.length && !corrupt;
    return { key, installed, bytes, totalBytes: model.totalBytes, label: model.label,
      state: corrupt ? 'corrupt' : installed ? 'ready' : present ? 'partial' : 'missing' };
  }));
}

export async function getStorageEstimate(): Promise<{usage: number; quota: number} | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  if (estimate.quota === undefined || estimate.usage === undefined) return null;
  return { usage: estimate.usage, quota: estimate.quota };
}

export async function requestPersistentStorage(): Promise<boolean> {
  return await navigator.storage?.persist?.() ?? false;
}

/** Only immutable, allowlisted model files are fetched. Text never enters this module. */
export async function installModel(
  key: ModelKey,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  requireCache();
  const model = MODEL_MANIFEST[key];
  const cache = await caches.open(MODEL_CACHE);
  const estimate = await getStorageEstimate();
  const status = (await getModelStatuses()).find(item => item.key === key)!;
  if (estimate && estimate.quota - estimate.usage < (model.totalBytes - status.bytes) * 1.15) {
    throw new Error('モデルを保存する空き容量が不足しています。不要なモデルや端末内のファイルを削除してください。');
  }
  let completed = 0;
  onProgress(0, model.totalBytes);
  for (const file of model.files) {
    signal?.throwIfAborted();
    const url = modelAssetUrl(key, file.path);
    const cached = await cache.match(url);
    if (cached?.headers.get('x-verified-sha256') === file.sha256 && Number(cached.headers.get('content-length')) === file.bytes) {
      completed += file.bytes;
      onProgress(completed, model.totalBytes);
      continue;
    }
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || !response.body) throw new Error(`モデルの取得に失敗しました (${response.status})。通信状態を確認し、再試行してください。`);
    const reader = response.body.getReader();
    // Preallocate the verified expected size instead of retaining a second copy of each chunk.
    const data = new Uint8Array(file.bytes);
    let received = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > file.bytes) throw new Error('モデルのファイル容量が検証値と一致しません。取得を停止しました。');
        data.set(value, received);
        received += value.byteLength;
        onProgress(completed + received, model.totalBytes);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
    if (received !== file.bytes) throw new Error('モデルの取得が途中で終了しました。再試行してください。');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x => x.toString(16).padStart(2, '0')).join('');
    signal?.throwIfAborted();
    if (hash !== file.sha256) throw new Error('モデルの SHA-256 が一致しません。安全のため保存しませんでした。再取得してください。');
    try {
      await cache.put(url, new Response(data, { headers: {
        'content-type': file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(file.bytes),
        'x-verified-sha256': hash,
      } }));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('保存容量が不足しました。不要なモデルを削除して再試行してください。');
      throw error;
    }
    completed += file.bytes;
    onProgress(completed, model.totalBytes);
  }
  if (!(await getModelStatuses()).find(item => item.key === key)?.installed) throw new Error('モデル資産の確認に失敗しました。再取得してください。');
}

export async function deleteModel(key: ModelKey): Promise<void> {
  requireCache();
  const cache = await caches.open(MODEL_CACHE);
  for (const file of MODEL_MANIFEST[key].files) await cache.delete(modelAssetUrl(key, file.path));
}

export async function verifiedCachedResponse(url: string): Promise<Response | undefined> {
  const entry = (Object.keys(MODEL_MANIFEST) as ModelKey[]).flatMap(key => MODEL_MANIFEST[key].files.map(file => ({ key, file })))
    .find(({ key, file }) => modelAssetUrl(key, file.path) === url);
  if (!entry) return undefined;
  const response = await (await caches.open(MODEL_CACHE)).match(url);
  if (!response || response.headers.get('x-verified-sha256') !== entry.file.sha256 || Number(response.headers.get('content-length')) !== entry.file.bytes) return undefined;
  return response;
}
