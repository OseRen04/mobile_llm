import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Lang, ModelKey, Progress, TranslateResult } from '../../../packages/translator-core/src';
import { getRoute, hasTranslatableText } from '../../../packages/translator-core/src';
import {
  deleteModel,
  getModelStatuses,
  getStorageEstimate,
  installModel,
  MODEL_MANIFEST,
  requestPersistentStorage,
  type ModelStatus,
} from '../../../packages/model-manager/src';
import { InferenceClient } from './inference-client';

const LANGUAGES: Record<Lang, { name: string; native: string; code: string }> = {
  ja: { name: '日本語', native: '日本語', code: 'JA' },
  en: { name: '英語', native: 'English', code: 'EN' },
  ru: { name: 'ロシア語', native: 'Русский', code: 'RU' },
};
const LANGUAGE_KEYS: Lang[] = ['ja', 'en', 'ru'];
const DIRECTION_KEY = 'local-translator.direction';
const MAX_CHARACTERS = 2_000;

type PendingDownload = {
  models: ModelKey[];
  request?: { source: Lang; target: Lang; text: string };
};

export interface AppProps {
  initialText?: string;
  onResultChange?: (output: string) => void;
  onSourceTextChange?: (text: string) => void;
}

function readDirection(): { source: Lang; target: Lang } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DIRECTION_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'source' in value && 'target' in value) {
      const { source, target } = value;
      if (LANGUAGE_KEYS.includes(source as Lang) && LANGUAGE_KEYS.includes(target as Lang) && source !== target) {
        return { source: source as Lang, target: target as Lang };
      }
    }
  } catch { /* Storage may be unavailable in private browsing. */ }
  return { source: 'ja', target: 'en' };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|storage.*full|容量/i.test(message)) return '保存容量が不足しています。不要なモデルを削除するか、端末の空き容量を増やして再試行してください。';
  if (/out of memory|memory|allocation|メモリ/i.test(message)) return '端末のメモリが不足した可能性があります。他のタブを閉じ、ページを再読み込みしてから再試行してください。';
  if (/failed to fetch|network|offline/i.test(message)) return '必要なファイルを取得できませんでした。ネット接続を確認して再試行してください。保存済みファイルが消去されている場合は、モデルを再取得してください。';
  return message || '処理に失敗しました。原文と前回の訳文は保持されています。再試行してください。';
}

function Icon({ name, size = 20 }: { name: 'translate' | 'swap' | 'copy' | 'arrow' | 'shield' | 'download' | 'check' | 'close' | 'settings' | 'trash'; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    translate: <><path d="M3 5h12M9 3v3c0 6-3 10-7 12M5 9c2 4 5 7 9 9" /><path d="m14 21 4-11 4 11m-6.5-4h5" /></>,
    swap: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4" /></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function App({ initialText = '', onResultChange, onSourceTextChange }: AppProps = {}) {
  const [direction, setDirection] = useState(readDirection);
  const { source, target } = direction;
  const [text, setText] = useState(initialText);
  const [output, setOutput] = useState('');
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [statuses, setStatuses] = useState<ModelStatus[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [pending, setPending] = useState<PendingDownload | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [activeDownload, setActiveDownload] = useState<ModelKey | null>(null);
  const [appReady, setAppReady] = useState(location.protocol === 'chrome-extension:');
  const [shellError, setShellError] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<InferenceClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const retryRef = useRef<(() => void) | null>(null);

  const count = Array.from(text).length;
  const route = getRoute(source, target);
  const pivot = route.length === 2;
  const installedCount = statuses.filter((model) => model.installed).length;
  const requiredReady = statuses.length > 0 && route.every((key) => statuses.some((model) => model.key === key && model.installed));
  const totalDownload = pending?.models.reduce((sum, key) => sum + MODEL_MANIFEST[key].totalBytes, 0) ?? 0;
  const percentage = progress?.total && progress.loaded !== undefined
    ? Math.max(0, Math.min(100, Math.round(progress.loaded / progress.total * 100)))
    : null;

  async function refreshModels() {
    const next = await getModelStatuses();
    if (mountedRef.current) setStatuses(next);
    const estimate = await getStorageEstimate();
    if (mountedRef.current) setStorage(estimate);
    return next;
  }

  useEffect(() => {
    mountedRef.current = true;
    void refreshModels().catch((failure: unknown) => setError(errorMessage(failure)));
    const connectionChanged = () => setOnline(navigator.onLine);
    const shellReady = () => { setAppReady(true); setShellError(false); };
    const shellFailed = () => { setAppReady(false); setShellError(true); };
    window.addEventListener('online', connectionChanged);
    window.addEventListener('offline', connectionChanged);
    window.addEventListener('local-translator:offline-ready', shellReady);
    window.addEventListener('offline-shell-error', shellFailed);
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) setAppReady(true);
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      abortRef.current?.abort();
      clientRef.current?.dispose();
      clientRef.current = null;
      window.removeEventListener('online', connectionChanged);
      window.removeEventListener('offline', connectionChanged);
      window.removeEventListener('local-translator:offline-ready', shellReady);
      window.removeEventListener('offline-shell-error', shellFailed);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(DIRECTION_KEY, JSON.stringify(direction)); } catch { /* Optional setting persistence. */ }
  }, [direction]);

  useEffect(() => { setText(initialText); }, [initialText]);
  useEffect(() => { onResultChange?.(output); }, [output, onResultChange]);
  useEffect(() => { onSourceTextChange?.(text); }, [text, onSourceTextChange]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  function getClient() {
    if (!clientRef.current) clientRef.current = new InferenceClient((next) => {
      if (busyRef.current && mountedRef.current) setProgress(next);
    });
    return clientRef.current;
  }

  function beginOperation(): number | null {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setProgress(null);
    setError('');
    setNotice('');
    abortRef.current = new AbortController();
    return ++operationRef.current;
  }

  function isCurrent(id: number) { return mountedRef.current && operationRef.current === id; }

  function finishOperation(id: number) {
    if (!isCurrent(id)) return;
    busyRef.current = false;
    abortRef.current = null;
    setBusy(false);
    setActiveDownload(null);
    setProgress(null);
  }

  async function executeDownload(plan: PendingDownload) {
    const id = beginOperation();
    if (id === null) return;
    retryRef.current = () => { void executeDownload(plan); };
    clientRef.current?.cancel();
    try {
      for (const key of plan.models) {
        if (!isCurrent(id)) return;
        setActiveDownload(key);
        await installModel(key, (loaded, total) => {
          if (isCurrent(id)) setProgress({ requestId: `install-${id}`, phase: 'download', loaded, total, message: MODEL_MANIFEST[key].label });
        }, abortRef.current!.signal);
        await refreshModels();
      }
      if (!isCurrent(id)) return;
      setActiveDownload(null);
      if (plan.request) {
        setProgress({ requestId: `translate-${id}`, phase: 'load' });
        const translated = await getClient().translate(plan.request.source, plan.request.target, plan.request.text);
        if (isCurrent(id)) { setOutput(translated.output); setResult(translated); }
      } else {
        setNotice('モデルを保存しました。保存済みモデルはネット接続なしで読み込めます。');
      }
    } catch (failure: unknown) {
      if (isCurrent(id)) setError(errorMessage(failure));
    } finally {
      if (isCurrent(id)) {
        await refreshModels().catch(() => undefined);
        finishOperation(id);
      }
    }
  }

  async function translate() {
    if (busyRef.current || pending) return;
    setError('');
    setNotice('');
    retryRef.current = () => { void translate(); };
    if (!hasTranslatableText(text)) {
      setError('翻訳する文章を入力してください。空白・改行・制御文字だけの文章は翻訳できません。');
      return;
    }
    if (count > MAX_CHARACTERS) {
      setError('入力は2,000文字までです。文章を分けて翻訳してください。');
      return;
    }
    const id = beginOperation();
    if (id === null) return;
    const snapshot = { source, target, text };
    try {
      const models = await refreshModels();
      if (!isCurrent(id)) return;
      const missing = route.filter((key) => !models.some((model) => model.key === key && model.installed));
      if (missing.length > 0) {
        if (!navigator.onLine) {
          setError('この翻訳に必要なモデルが保存されていません。オンラインにして、モデルを事前にダウンロードしてください。');
        } else {
          setPending({ models: missing, request: snapshot });
        }
        return;
      }
      setProgress({ requestId: `translate-${id}`, phase: 'load' });
      const translated = await getClient().translate(snapshot.source, snapshot.target, snapshot.text);
      if (isCurrent(id)) { setOutput(translated.output); setResult(translated); }
    } catch (failure: unknown) {
      if (isCurrent(id)) setError(errorMessage(failure));
    } finally { finishOperation(id); }
  }

  function cancel() {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clientRef.current?.cancel();
    busyRef.current = false;
    setBusy(false);
    setActiveDownload(null);
    setProgress(null);
    setNotice('処理を中断しました。原文と前回の訳文は保持されています。');
    void refreshModels().catch(() => undefined);
  }

  function swap() {
    if (busyRef.current) return;
    setDirection({ source: target, target: source });
    if (output.length > 0) { setText(output); setOutput(text); }
    setResult(null);
    setError('');
    setNotice('');
  }

  async function copy() {
    if (!output) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(output);
      setNotice('訳文をコピーしました。');
    } catch {
      outputRef.current?.focus();
      outputRef.current?.select();
      outputRef.current?.setSelectionRange(0, output.length);
      setNotice('自動コピーを利用できません。選択された訳文を、端末のメニューからコピーしてください。');
    }
  }

  async function removeModel(key: ModelKey) {
    const id = beginOperation();
    if (id === null) return;
    retryRef.current = () => { void removeModel(key); };
    try {
      getClient().cancel();
      await deleteModel(key);
      await refreshModels();
      if (isCurrent(id)) setNotice(`${MODEL_MANIFEST[key].label}を削除しました。再利用時にはダウンロードが必要です。`);
    } catch (failure: unknown) { if (isCurrent(id)) setError(errorMessage(failure)); }
    finally { finishOperation(id); }
  }

  function requestDownload(key: ModelKey) {
    if (busyRef.current) return;
    setError('');
    if (!navigator.onLine) {
      setError('モデルのダウンロードにはネット接続が必要です。オンラインにして再試行してください。');
      return;
    }
    setPending({ models: [key] });
  }

  const progressLabel = progress?.phase === 'download'
    ? `${progress.message ?? 'モデル'}をダウンロード中${percentage !== null ? ` · ${percentage}%` : ''}`
    : progress?.phase === 'infer'
      ? `翻訳中${progress.step ? ` · ${progress.step}/${progress.steps ?? route.length}段階` : ''}${progress.chunk ? ` · ${progress.chunk}/${progress.chunks ?? '?'}分割` : ''}`
      : 'モデルを読み込み中';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#translator">翻訳画面へ移動</a>
      <header className="site-header">
        <a className="brand" href="./" aria-label="Local Translator ホーム">
          <span className="brand-mark"><Icon name="translate" size={25} /></span>
          <span>Local<span className="brand-light"> Translator</span></span>
        </a>
        <div className="header-actions">
          <span className={`network-status ${online ? '' : 'is-offline'}`}><span className="status-dot" />{online ? 'オンライン' : 'オフライン'}</span>
          <button className={`button button-quiet model-toggle ${modelsOpen ? 'is-active' : ''}`} onClick={() => setModelsOpen(!modelsOpen)} aria-label="モデル管理" aria-expanded={modelsOpen} aria-controls="model-manager"><Icon name="settings" size={18} /><span>モデル管理</span></button>
        </div>
      </header>

      <main id="translator" className="main-content">
        <div className="intro">
          <div><div className="eyebrow"><span />ON YOUR DEVICE</div><h1>翻訳を、もっと身近に。</h1><p>日本語・英語・ロシア語を、あなたの端末で。</p></div>
          <span className="privacy-badge"><Icon name="shield" size={19} />文章は外部へ送信しません</span>
        </div>

        {!online && <div className="offline-banner" role="status"><span className="status-dot" /><div><strong>オフラインで利用中</strong><span>保存済みのモデルで翻訳できます。未取得のモデルにはネット接続が必要です。</span></div></div>}

        <section className="translator-card" aria-label="テキスト翻訳">
          <div className="language-row">
            <div className="language-control"><label htmlFor="source-language">翻訳元</label><select id="source-language" value={source} disabled={busy} onChange={(event) => {
              const next = event.target.value as Lang;
              setDirection({ source: next, target: next === target ? source : target });
              setResult(null);
            }}>{LANGUAGE_KEYS.map((key) => <option key={key} value={key}>{LANGUAGES[key].native}</option>)}</select></div>
            <button className="swap-button" onClick={swap} disabled={busy} aria-label="言語と原文・訳文を入れ替える" title="言語と原文・訳文を入れ替える"><Icon name="swap" size={19} /></button>
            <div className="language-control target-language"><label htmlFor="target-language">翻訳先</label><select id="target-language" value={target} disabled={busy} onChange={(event) => { setDirection({ source, target: event.target.value as Lang }); setResult(null); }}>{LANGUAGE_KEYS.map((key) => <option key={key} value={key} disabled={key === source}>{LANGUAGES[key].native}</option>)}</select></div>
          </div>

          <div className="translation-panes">
            <div className="text-pane source-pane">
              <div className="pane-heading"><label htmlFor="source-text">原文</label><span className="language-tag">{LANGUAGES[source].code}</span></div>
              <textarea id="source-text" className="text-area" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void translate(); } }} disabled={busy} placeholder="翻訳する文章を入力、または貼り付けてください。" spellCheck={false} aria-describedby="character-count input-hint" aria-invalid={count > MAX_CHARACTERS} />
              <div className="pane-footer"><button className="text-button" disabled={busy || (!text && !output)} onClick={() => { setText(''); setOutput(''); setResult(null); setError(''); setNotice(''); }}>クリア</button><span id="character-count" className={`character-count ${count > MAX_CHARACTERS ? 'over-limit' : ''}`}>{count.toLocaleString()}<span> / 2,000</span></span></div>
              <div className="translate-action">{busy ? <><span className="working-label"><span className="spinner" />処理中</span><button className="button button-outline" onClick={cancel}>中断する</button></> : <><span id="input-hint" className="input-hint">入力後にボタンを押して翻訳</span><button className="button button-primary" onClick={() => { void translate(); }}>翻訳する<Icon name="arrow" size={19} /></button></>}</div>
            </div>
            <div className="text-pane output-pane">
              <div className="pane-heading"><label htmlFor="translated-text">訳文</label><span className="language-tag">{LANGUAGES[target].code}</span></div>
              <textarea ref={outputRef} id="translated-text" className="text-area output-text" value={output} onChange={(event) => setOutput(event.target.value)} placeholder="翻訳結果がここに表示されます。" spellCheck={false} aria-describedby="output-hint" />
              <div className="pane-footer"><span id="output-hint" className="edit-hint">訳文は直接編集できます</span><button className="copy-button" disabled={!output} onClick={() => { void copy(); }}><Icon name="copy" size={16} />コピー</button></div>
              <div className="result-meta" role="status" aria-live="polite" aria-atomic="true">{result ? <><span className="result-success"><Icon name="check" size={15} />翻訳完了</span><span>{result.steps}段階 · {(result.elapsedMs / 1000).toFixed(1)}秒</span></> : <><span className="result-empty-dot" /><span>端末内の翻訳モデルを使用</span></>}</div>
            </div>
          </div>

          <div className="route-bar"><span className={`route-badge ${pivot ? 'is-pivot' : ''}`}>{pivot ? '英語経由 · 2段階' : '直接翻訳 · 1段階'}</span><span>{LANGUAGES[source].name}<span className="route-arrow">→</span>{pivot && <>英語<span className="route-arrow">→</span></>}{LANGUAGES[target].name}</span><span className="experimental-badge">実験的対応</span></div>
        </section>

        {pivot && <p className="pivot-note">日本語とロシア語の翻訳は英語を経由します。意味や細かなニュアンスが失われる場合があります。</p>}
        {count > MAX_CHARACTERS && <p className="validation-message" role="alert">2,000文字を超えています。文章を分けて入力してください。</p>}

        <div className="feedback-area" aria-live="polite" aria-atomic="true">
          {shellError && <p className="message message-error" role="alert">アプリのオフライン用ファイルを保存できませんでした。翻訳は利用できますが、オフラインでのアプリ再起動にはネット接続が必要な場合があります。オンラインでページを再読み込みしてください。</p>}
          {busy && <div className="progress-panel"><div className="progress-heading"><span className="spinner" /><span>{progressLabel}</span>{progress?.phase === 'download' && progress.loaded !== undefined && progress.total !== undefined && <span className="progress-bytes">{formatBytes(progress.loaded)} / {formatBytes(progress.total)}</span>}</div>{percentage !== null && progress?.phase === 'download' ? <progress value={percentage} max="100" aria-label="モデルのダウンロード進捗" /> : <progress aria-label={progressLabel} />}</div>}
          {error && <div className="message message-error" role="alert"><div><strong>処理を完了できませんでした</strong><p>{error}</p></div><button className="button button-outline" disabled={busy} onClick={() => { if (retryRef.current) retryRef.current(); else void refreshModels().then(() => setError('')).catch((failure: unknown) => setError(errorMessage(failure))); }}>再試行</button></div>}
          {notice && <p className="message message-notice"><Icon name="check" size={18} />{notice}</p>}
        </div>

        {result?.intermediateEnglish && <details className="intermediate"><summary>中間の英語訳を確認する</summary><p lang="en">{result.intermediateEnglish}</p></details>}

        <div className="readiness-strip"><div><span className={`status-dot ${requiredReady ? 'ready' : 'muted'}`} /><span>{requiredReady ? 'この翻訳に必要なモデルは保存済み' : '必要なモデルは初回翻訳時にダウンロード'}</span></div><button className="text-button" onClick={() => setModelsOpen(!modelsOpen)}>モデル {installedCount}/2<Icon name="arrow" size={15} /></button></div>

        <section id="model-manager" className="model-manager" hidden={!modelsOpen} aria-label="モデル管理">
          <div className="section-heading"><div><span className="eyebrow">LOCAL STORAGE</span><h2>翻訳モデル</h2><p>必要なモデルだけを、このブラウザに保存します。</p></div><button className="icon-button" aria-label="モデル管理を閉じる" onClick={() => setModelsOpen(false)}><Icon name="close" /></button></div>
          <div className="model-grid">{(['toEnglish', 'fromEnglish'] as ModelKey[]).map((key) => {
            const model = MODEL_MANIFEST[key];
            const status = statuses.find((item) => item.key === key);
            const installed = status?.installed ?? false;
            const downloading = activeDownload === key;
            const stateLabel = downloading ? '取得中' : installed ? '保存済み' : status?.state === 'corrupt' ? '破損・再取得が必要' : status?.state === 'partial' ? '一部保存済み' : '未取得';
            return <article key={key} className="model-card"><div className="model-card-heading"><span className="model-symbol"><Icon name="translate" size={22} /></span><span className={`model-state ${installed ? 'is-ready' : ''}`}>{stateLabel}</span></div><h3>{model.label}</h3><p className="model-directions">{key === 'toEnglish' ? '日本語・ロシア語 → 英語' : '英語 → 日本語・ロシア語'}</p><div className="model-size">{formatBytes(model.totalBytes)}<span>q8 · {(model.parameters / 1_000_000).toFixed(1)}M パラメータ</span></div><p className="model-revision">固定リビジョン <code>{model.revision.slice(0, 8)}</code></p><div className="model-card-footer"><a href={model.licenseUrl} target="_blank" rel="noreferrer">ライセンス ↗</a>{installed ? <button className="button button-small button-outline" disabled={busy} onClick={() => { void removeModel(key); }}><Icon name="trash" size={15} />削除</button> : <button className="button button-small button-outline" disabled={busy} onClick={() => requestDownload(key)}><Icon name="download" size={15} />{status?.state === 'partial' || status?.state === 'corrupt' ? '再取得' : 'ダウンロード'}</button>}</div></article>;
          })}</div>
          <div className="storage-note"><p>{storage ? <>このサイトの使用量 {formatBytes(storage.usage)} / ブラウザの推定上限 {formatBytes(storage.quota)}。 </> : null}ブラウザが保存したモデルを自動削除することがあります。文章と訳文は保存しません。</p><button className="text-button" disabled={busy} onClick={() => { void requestPersistentStorage().then((granted) => setNotice(granted ? 'ブラウザから永続ストレージの許可を得ました。端末やブラウザの設定による削除は防げません。' : 'この環境では永続ストレージの許可を得られませんでした。モデルが自動削除された場合は再取得してください。')).catch((failure: unknown) => setError(errorMessage(failure))); }}>モデルの保存維持をリクエスト</button></div>
        </section>

        <section className="privacy-note" aria-label="プライバシーとオフライン利用"><span className="privacy-note-icon"><Icon name="shield" size={23} /></span><div><h2>あなたの言葉は、あなたの手元に。</h2><p>翻訳はこの端末だけで処理します。初回のモデル取得にはネット接続が必要です。取得後は、アプリとモデルがブラウザに保存されている間、オフラインで利用できます。</p></div></section>

        <details className="install-help"><summary>スマートフォンのホーム画面に追加する</summary><p>iPhoneのSafariでは共有メニューから「ホーム画面に追加」、AndroidのChromeではメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。{appReady ? 'アプリのオフライン用ファイルは保存済みです。' : '初回はオンラインでアプリとモデルを取得してください。'} PWAから別のアプリやサイトの入力欄を直接書き換えることはできません。</p></details>
      </main>

      <footer className="site-footer"><span>LOCAL TRANSLATOR</span><span>日本語 / English / Русский</span><span>OPUS-MT · 端末内処理</span></footer>

      <dialog ref={dialogRef} className="download-dialog" aria-labelledby="download-title" aria-describedby="download-description" onCancel={(event) => { event.preventDefault(); setPending(null); }}>
        <div className="dialog-icon"><Icon name="download" size={27} /></div><h2 id="download-title">翻訳モデルを保存します</h2><p id="download-description">はじめに、必要なモデルをHugging Faceからダウンロードします。ネット接続が必要です。</p><ul className="download-list">{pending?.models.map((key) => <li key={key}><span>{MODEL_MANIFEST[key].label}</span><strong>{formatBytes(MODEL_MANIFEST[key].totalBytes)}</strong></li>)}</ul><div className="download-total"><span>ダウンロード容量</span><strong>{formatBytes(totalDownload)}</strong></div>{storage && storage.quota - storage.usage < totalDownload * 1.5 && <p className="validation-message">空き容量に余裕がありません。保存時には表示容量以上の空きが必要になる場合があります。</p>}<p className="dialog-note">接続先：huggingface.co とモデル配信CDN。配布元にIPアドレス等が伝わります。翻訳する文章は送信しません。モデルはこのブラウザに保存されます。</p><div className="dialog-actions"><button className="button button-outline" onClick={() => setPending(null)}>キャンセル</button><button className="button button-primary" onClick={() => { const plan = pending; setPending(null); if (plan) void executeDownload(plan); }}><Icon name="download" size={17} />ダウンロード{pending?.request ? 'して翻訳' : ''}</button></div>
      </dialog>
    </div>
  );
}
