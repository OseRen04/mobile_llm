import type { Lang, ModelKey, Progress, TranslateResult, WorkerRequest, WorkerResponse } from '../../../packages/translator-core/src';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class InferenceClient {
  private worker?: Worker;
  private pending = new Map<string, Pending>();
  constructor(private onProgress: (progress: Progress) => void) {}

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    if (!globalThis.Worker || !globalThis.WebAssembly) throw new Error('このブラウザは Web Worker / WebAssembly に対応していません。最新のブラウザを使用してください。');
    const worker = new Worker(new URL('../../../packages/inference-worker/src/worker.ts', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'INIT', runtimeUrl: new URL('runtime/', document.baseURI).href });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === 'PROGRESS') {
        if (this.pending.has(message.requestId)) this.onProgress(message);
        return;
      }
      const id = message.type === 'RESULT' ? message.result.requestId : message.requestId;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.type === 'ERROR') {
        const error = new Error(message.message);
        error.name = message.code;
        pending.reject(error);
      } else pending.resolve(message.type === 'RESULT' ? message.result : undefined);
    };
    worker.onerror = () => {
      if (this.worker === worker) this.fail('Worker が停止しました。メモリ不足の可能性があります。不要なタブを閉じて再試行してください。');
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.fail('推論処理との通信に失敗しました。再試行してください。');
    };
    this.worker = worker;
    return worker;
  }

  private fail(message: string): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private send<T>(message: WorkerRequest, id: string): Promise<T> {
    if (this.pending.size) return Promise.reject(new Error('別の処理が進行中です。完了または中断してから再試行してください。'));
    return new Promise((resolve, reject) => {
      try {
        const worker = this.getWorker();
        this.pending.set(id, { resolve, reject });
        worker.postMessage(message);
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  load(model: ModelKey): Promise<void> {
    const requestId = crypto.randomUUID();
    return this.send({ type: 'LOAD_MODEL', requestId, model }, requestId);
  }

  translate(source: Lang, target: Lang, text: string): Promise<TranslateResult> {
    const requestId = crypto.randomUUID();
    return this.send({ type: 'TRANSLATE', request: { source, target, text, requestId } }, requestId);
  }

  cancel(): void { this.fail('処理を中断しました。原文と前回の完成結果は保持されています。'); }
  dispose(): void { this.fail('推論処理を終了しました。'); }
}
