import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceClient } from '../../apps/web/src/inference-client';
import type { Progress, TranslateResult, WorkerResponse } from '../../packages/translator-core/src';

class WorkerMock {
  static instances: WorkerMock[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { WorkerMock.instances.push(this); }
  emit(data: WorkerResponse): void { this.onmessage?.({ data } as MessageEvent<WorkerResponse>); }
  get requestId(): string {
    const message = this.postMessage.mock.calls[this.postMessage.mock.calls.length - 1]![0];
    return message.requestId ?? message.request.requestId;
  }
}

const result = (requestId: string): TranslateResult => ({
  requestId, source: 'ja', target: 'en', output: 'Hello', steps: 1, elapsedMs: 10,
});
let client: InferenceClient;
let progress = vi.fn<(_progress: Progress) => void>();
let serial = 0;
beforeEach(() => {
  WorkerMock.instances = [];
  vi.stubGlobal('Worker', WorkerMock);
  vi.stubGlobal('document', { baseURI: 'https://localhost/app/' });
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++serial}` });
  progress = vi.fn<(_progress: Progress) => void>();
  client = new InferenceClient(progress);
});
afterEach(() => {
  client.dispose();
  vi.unstubAllGlobals();
});

describe('Worker lifecycle and request ownership', () => {
  it('initializes a local runtime and resolves only the matching request', async () => {
    const pending = client.translate('ja', 'en', 'こんにちは');
    const worker = WorkerMock.instances[0]!;
    expect(worker.postMessage).toHaveBeenNthCalledWith(1, { type: 'INIT', runtimeUrl: 'https://localhost/app/runtime/' });
    worker.emit({ type: 'PROGRESS', requestId: 'wrong-request', phase: 'infer' });
    expect(progress).not.toHaveBeenCalled();
    worker.emit({ type: 'PROGRESS', requestId: worker.requestId, phase: 'infer' });
    expect(progress).toHaveBeenCalledTimes(1);
    worker.emit({ type: 'RESULT', result: result(worker.requestId) });
    await expect(pending).resolves.toMatchObject({ output: 'Hello' });
  });

  it('rejects concurrent requests before they reach a worker', async () => {
    const first = client.translate('ja', 'en', '一');
    const assertion = expect(first).rejects.toThrow('中断');
    await expect(client.translate('ja', 'ru', '二')).rejects.toThrow('別の処理');
    expect(WorkerMock.instances[0]!.postMessage).toHaveBeenCalledTimes(2);
    client.cancel();
    await assertion;
  });

  it('terminates on cancel, ignores late results/errors from the old worker, and regenerates on retry', async () => {
    const first = client.translate('ja', 'en', '原文');
    const firstRejected = expect(first).rejects.toThrow('中断');
    const oldWorker = WorkerMock.instances[0]!;
    const oldId = oldWorker.requestId;
    client.cancel();
    await firstRejected;
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    const retry = client.translate('ja', 'en', '再試行');
    const newWorker = WorkerMock.instances[1]!;
    oldWorker.emit({ type: 'RESULT', result: result(oldId) });
    oldWorker.emit({ type: 'RESULT', result: result(newWorker.requestId) });
    oldWorker.onerror?.();
    oldWorker.onmessageerror?.();
    expect(newWorker.terminate).not.toHaveBeenCalled();
    newWorker.emit({ type: 'RESULT', result: result(newWorker.requestId) });
    await expect(retry).resolves.toMatchObject({ output: 'Hello' });
  });

  it.each(['onerror', 'onmessageerror'] as const)('rejects pending work on %s and creates a fresh worker', async (event) => {
    const pending = client.load('toEnglish');
    const rejected = expect(pending).rejects.toThrow();
    const oldWorker = WorkerMock.instances[0]!;
    oldWorker[event]?.();
    await rejected;
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    const retry = client.load('fromEnglish');
    const next = WorkerMock.instances[1]!;
    next.emit({ type: 'READY', requestId: next.requestId, model: 'fromEnglish' });
    await expect(retry).resolves.toBeUndefined();
  });

  it('propagates a model error and allows the next request', async () => {
    const pending = client.load('toEnglish');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'model-missing', message: 'Download first' });
    const worker = WorkerMock.instances[0]!;
    worker.emit({ type: 'ERROR', requestId: worker.requestId, code: 'model-missing', message: 'Download first' });
    await rejected;
    const retry = client.load('toEnglish');
    worker.emit({ type: 'READY', requestId: worker.requestId, model: 'toEnglish' });
    await expect(retry).resolves.toBeUndefined();
  });

  it('rejects unsupported environments without leaving a pending request', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(client.translate('ja', 'en', '文章')).rejects.toThrow('対応していません');
    vi.stubGlobal('Worker', WorkerMock);
    const retry = client.load('toEnglish');
    const worker = WorkerMock.instances[0]!;
    worker.emit({ type: 'READY', requestId: worker.requestId, model: 'toEnglish' });
    await expect(retry).resolves.toBeUndefined();
  });
});
