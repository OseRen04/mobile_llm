import { AutoModelForSeq2SeqLM, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer, type Tensor } from '@huggingface/transformers';
import { translate, TranslatorError, type ModelKey, type TranslationBackend, type WorkerRequest, type WorkerResponse } from '../../translator-core/src';
import { MODEL_MANIFEST, getModelStatuses, verifiedCachedResponse } from '../../model-manager/src';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let runtimeUrl: string | undefined;
let resident: { key: ModelKey; model: PreTrainedModel; tokenizer: PreTrainedTokenizer } | undefined;
let busy = false;
let currentRequestId = '';
let controller: AbortController | undefined;
const nativeFetch = globalThis.fetch.bind(globalThis);

// All model reads must hit our verified cache. Missing assets never trigger implicit downloads.
// v3.8.1 requires this flag even for a cache hit with local_files_only.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async (request: string) => verifiedCachedResponse(String(request)),
  put: async () => { throw new Error('Inference cannot download model assets'); },
};
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!runtimeUrl || !url.startsWith(runtimeUrl) || !/\/ort-wasm-[\w.-]+\.(wasm|mjs)$/.test(new URL(url).pathname)
    || (init?.method && init.method !== 'GET') || init?.body) {
    throw new Error('推論中の外部通信は無効です。必要なモデルを取得してください。');
  }
  return nativeFetch(input, init);
};

function send(message: WorkerResponse): void { scope.postMessage(message); }

const backend: TranslationBackend = {
  async load(key) {
    if (resident?.key === key) return;
    if (resident) await backend.release(resident.key);
    if (!runtimeUrl) throw new Error('実行ライブラリが初期化されていません。ページを再読み込みしてください。');
    if (!(await getModelStatuses()).find(item => item.key === key)?.installed) {
      throw new TranslatorError('model-missing', '必要なモデル資産がありません。オンラインでモデルを取得し直してください。');
    }
    send({ type: 'PROGRESS', requestId: currentRequestId, phase: 'load', message: `${MODEL_MANIFEST[key].label} を読み込み中` });
    const definition = MODEL_MANIFEST[key];
    const options = { revision: definition.revision, local_files_only: true };
    const tokenizer = await AutoTokenizer.from_pretrained(definition.id, options);
    const model = await AutoModelForSeq2SeqLM.from_pretrained(definition.id, { ...options, device: 'wasm', dtype: 'q8' });
    resident = { key, model, tokenizer };
  },
  async countTokens(key, text) {
    await backend.load(key);
    const input = resident!.tokenizer(text, { truncation: false, padding: false });
    return input.input_ids.size;
  },
  async run(key, text) {
    await backend.load(key);
    const { model, tokenizer } = resident!;
    const input = tokenizer(text, { truncation: false, padding: false });
    if (input.input_ids.size > 192) throw new TranslatorError('input-tokens', '入力がモデルの上限を超えています。短くして再試行してください。');
    const maxNewTokens = 256;
    const generated = await model.generate({ ...input, max_new_tokens: maxNewTokens, num_beams: 1, do_sample: false }) as Tensor;
    const ids = generated.tolist()[0] as bigint[];
    const eos = (model.config as unknown as { eos_token_id: number | number[] }).eos_token_id;
    const eosIds = (Array.isArray(eos) ? eos : [eos]).map(Number);
    // Marian may force EOS at the generation limit: that output is still incomplete.
    const truncated = ids.length >= maxNewTokens + 1 || !eosIds.includes(Number(ids.at(-1)));
    return { text: tokenizer.batch_decode(generated, { skip_special_tokens: true })[0] ?? '', truncated };
  },
  async release(key) {
    if (resident?.key !== key) return;
    const previous = resident;
    resident = undefined;
    await previous.model.dispose();
  },
};

scope.onmessage = async (event: MessageEvent<WorkerRequest | { type: 'INIT'; runtimeUrl: string }>) => {
  const message = event.data;
  if (message.type === 'INIT') {
    const url = new URL(message.runtimeUrl);
    // Chrome extension origins serialize as null; compare protocol and host explicitly.
    const own = new URL(scope.location.href);
    if (url.protocol !== own.protocol || url.host !== own.host || !url.pathname.endsWith('/runtime/')) return;
    runtimeUrl = url.href;
    if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = runtimeUrl;
    return;
  }
  if (message.type === 'CANCEL') { if (message.requestId === currentRequestId) controller?.abort(); return; }
  if (message.type === 'RELEASE_MODEL') { if (!busy) await backend.release(message.model); return; }
  const requestId = message.type === 'TRANSLATE' ? message.request.requestId : message.requestId;
  if (busy) { send({ type: 'ERROR', requestId, code: 'busy', message: '別の翻訳処理が進行中です。' }); return; }
  busy = true;
  currentRequestId = requestId;
  controller = new AbortController();
  try {
    if (message.type === 'LOAD_MODEL') {
      await backend.load(message.model);
      send({ type: 'READY', requestId, model: message.model });
    } else {
      const result = await translate(message.request, backend, progress => send({ type: 'PROGRESS', ...progress }), controller.signal);
      send({ type: 'RESULT', result });
    }
  } catch (error) {
    send({ type: 'ERROR', requestId, code: error instanceof TranslatorError ? error.code : 'inference-failed',
      message: error instanceof TranslatorError ? error.message : 'モデルの実行に失敗しました。メモリの空きを確保し、再試行してください。改善しない場合はモデルを再取得してください。' });
    console.error('Inference failed', error instanceof Error ? error.name : 'unknown');
    if (resident) await backend.release(resident.key).catch(() => undefined);
  } finally { busy = false; controller = undefined; }
};
