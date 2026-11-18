import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../web/src/App';
import { capturePageText, replacePageText } from './page-editor';
import '../../web/src/styles.css';
import './popup.css';

function Extension() {
  const [initialText, setInitialText] = useState('');
  const [captureVersion, setCaptureVersion] = useState(0);
  const [source, setSource] = useState('');
  const [output, setOutput] = useState('');
  const [captured, setCaptured] = useState<{ tabId: number; token: string; text: string }>();
  const [notice, setNotice] = useState('ページの入力欄にカーソルを置き、「入力欄を読み取る」を押してください。');
  const [busy, setBusy] = useState(false);

  const capture = async () => {
    setBusy(true);
    setCaptured(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('このページは操作できません。原文を貼り付けて、訳文をコピーしてください。');
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePageText });
      const result = injection?.result;
      if (!result?.ok || !result.text) throw new Error(result?.reason ?? '入力欄を確認できません。原文を貼り付けてください。');
      setInitialText(result.text);
      setSource(result.text);
      setOutput('');
      setCaptureVersion(version => version + 1);
      if (result.token) setCaptured({ tabId: tab.id, token: result.token, text: result.text });
      setNotice(result.token ? '入力欄を読み取りました。翻訳後に原文と訳文を確認して置換できます。' : '選択文を読み取りました。訳文をコピーして利用してください。');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'ページを操作できません。'); }
    finally { setBusy(false); }
  };

  const replace = async () => {
    if (!captured || !output.trim() || source !== captured.text) return;
    // Approval is tied to the exact source and editable result shown in the popup.
    if (!window.confirm(`この入力欄を置換しますか？\n\n原文：\n${captured.text}\n\n訳文：\n${output}\n\nフォームの送信は行いません。`)) return;
    setBusy(true);
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: captured.tabId }, func: replacePageText, args: [captured.token, captured.text, output] });
      if (!injection?.result?.ok) throw new Error(injection?.result?.reason ?? '置換できません。訳文をコピーしてください。');
      setNotice('入力欄へ置換しました。フォームの送信は行っていません。');
      setCaptured(undefined);
    } catch (error) { setNotice(error instanceof Error ? error.message : '置換できません。訳文をコピーしてください。'); }
    finally { setBusy(false); }
  };

  const onSource = useCallback((text: string) => setSource(text), []);
  const onResult = useCallback((text: string) => setOutput(text), []);
  return <>
    <aside className="page-tools" aria-label="ページの入力欄との連携">
      <div className="page-tools-title"><strong>ページの入力欄</strong><span>Chrome 拡張 · 実験的対応</span></div>
      <div className="page-tool-actions">
        <button onClick={capture} disabled={busy}>入力欄を読み取る</button>
        <button onClick={replace} disabled={busy || !captured || !output.trim() || source !== captured.text}>確認して入力欄へ置換</button>
      </div>
      <p role="status">{notice}</p>
    </aside>
    <App key={captureVersion} initialText={initialText} onSourceTextChange={onSource} onResultChange={onResult} />
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Extension /></StrictMode>);
