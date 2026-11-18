export interface CaptureResult {
  ok: boolean;
  text?: string;
  token?: string;
  reason?: string;
}

/** Self-contained: Chrome serializes this function into its isolated page world. */
export function capturePageText(): CaptureResult {
  type CaptureState = {
    token: string;
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
    kind: 'input' | 'textarea' | 'editable';
    href: string;
    fullText: string;
    selectedText: string;
    start: number;
    end: number;
    selectionStart: number;
    selectionEnd: number;
  };
  const context = window as Window & { __localTranslatorCapture?: CaptureState };
  delete context.__localTranslatorCapture;
  const fallback = (reason: string): CaptureResult => {
    const selected = window.getSelection()?.toString();
    return selected ? { ok: true, text: selected, reason } : { ok: false, reason };
  };
  if (!/^https?:$/.test(location.protocol) || window.top !== window) {
    return { ok: false, reason: 'このページやフレームは操作できません。文章を貼り付けてください。' };
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return fallback('入力欄を選択してください。');

  const metadata = [active.id, active.getAttribute('name'), active.getAttribute('autocomplete'),
    active.getAttribute('aria-label'), active.getAttribute('placeholder'), active.getAttribute('inputmode')];
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    metadata.push(...Array.from(active.labels ?? []).map((label) => label.textContent));
  }
  let ancestor: HTMLElement | null = active.parentElement;
  for (let level = 0; ancestor && level < 3; level++, ancestor = ancestor.parentElement) {
    metadata.push(ancestor.id, ancestor.getAttribute('name'), ancestor.getAttribute('aria-label'));
  }
  if (/(?:password|passwd|pwd|passcode|one[-_ ]?time|\botp\b|(?:^|[\s_-])pin(?:$|[\s_-])|cc[-_ ]|credit|debit|card[-_ ]?(?:number|no|holder|security|verification|exp)|cvv|cvc|security[-_ ]?code|verification[-_ ]?code|expir(?:y|ation)|iban|bank[-_ ]?account|routing[-_ ]?number|ssn|social[-_ ]?security|api[-_ ]?key|access[-_ ]?token|secret|numeric|decimal|パスワード|暗証|認証コード|クレジット|カード番号|口座|парол|карт[аы]|пин)/iu.test(metadata.join(' '))
    || active.matches('[data-sensitive], [data-private]')
    || active instanceof HTMLInputElement && !['text', 'search'].includes(active.type)) {
    return { ok: false, reason: 'パスワード・決済情報などの入力欄は取得・置換しません。' };
  }
  const style = getComputedStyle(active);
  if (active.closest('[hidden], [inert], [aria-hidden="true"]') || style.display === 'none'
    || style.visibility === 'hidden' || style.visibility === 'collapse' || !active.getClientRects().length
    || active.shadowRoot || active.getRootNode() !== document) {
    return fallback('表示されている通常の入力欄のみ置換できます。');
  }

  let kind: CaptureState['kind'];
  let fullText: string;
  let selectionStart: number;
  let selectionEnd: number;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active.disabled || active.readOnly || active.matches(':disabled') || active.selectionStart === null || active.selectionEnd === null) {
      return fallback('編集可能な通常の入力欄のみ置換できます。');
    }
    kind = active instanceof HTMLInputElement ? 'input' : 'textarea';
    fullText = active.value;
    selectionStart = active.selectionStart;
    selectionEnd = active.selectionEnd;
  } else {
    if (!['true', 'plaintext-only', ''].includes(active.getAttribute('contenteditable') ?? 'false')
      || active.getAttribute('aria-readonly') === 'true'
      || active.closest('.ProseMirror, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, [data-slate-editor], [data-lexical-editor]')
      || Array.from(active.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE)) {
      return fallback('このエディタは置換に対応していません。訳文をコピーしてください。');
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1) return fallback('入力欄の選択位置を確認できません。');
    const range = selection.getRangeAt(0);
    if (!active.contains(range.startContainer) || !active.contains(range.endContainer)) {
      return fallback('選択範囲が入力欄の外にあります。');
    }
    kind = 'editable';
    fullText = active.textContent ?? '';
    const before = document.createRange();
    before.selectNodeContents(active);
    before.setEnd(range.startContainer, range.startOffset);
    selectionStart = before.toString().length;
    selectionEnd = selectionStart + range.toString().length;
  }

  const start = selectionStart === selectionEnd ? 0 : selectionStart;
  const end = selectionStart === selectionEnd ? fullText.length : selectionEnd;
  const selectedText = fullText.slice(start, end);
  if (!selectedText.trim()) return { ok: false, reason: '翻訳する文章がありません。' };
  const token = crypto.randomUUID();
  context.__localTranslatorCapture = {
    token, element: active, kind, href: location.href, fullText, selectedText,
    start, end, selectionStart, selectionEnd,
  };
  return { ok: true, text: selectedText, token };
}

/** Revalidates the captured field before an explicit user-requested replacement. */
export function replacePageText(token: string, expectedText: string, replacement: string): { ok: boolean; reason?: string } {
  type CaptureState = {
    token: string;
    element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
    kind: 'input' | 'textarea' | 'editable';
    href: string;
    fullText: string;
    selectedText: string;
    start: number;
    end: number;
    selectionStart: number;
    selectionEnd: number;
  };
  const context = window as Window & { __localTranslatorCapture?: CaptureState };
  const state = context.__localTranslatorCapture;
  const failure = (reason: string): { ok: boolean; reason: string } => ({ ok: false, reason });
  if (!state || state.token !== token || state.selectedText !== expectedText || typeof replacement !== 'string'
    || !replacement.trim()) return failure('取得した文章を確認できません。もう一度取得してください。');
  const element = state.element;
  if (!/^https?:$/.test(location.protocol) || window.top !== window || state.href !== location.href
    || !element.isConnected || element.ownerDocument !== document || document.activeElement !== element
    || element.getRootNode() !== document || element.shadowRoot) {
    return failure('ページまたは入力欄が変わりました。もう一度取得してください。');
  }

  const metadata = [element.id, element.getAttribute('name'), element.getAttribute('autocomplete'),
    element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('inputmode')];
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    metadata.push(...Array.from(element.labels ?? []).map((label) => label.textContent));
  }
  let ancestor: HTMLElement | null = element.parentElement;
  for (let level = 0; ancestor && level < 3; level++, ancestor = ancestor.parentElement) {
    metadata.push(ancestor.id, ancestor.getAttribute('name'), ancestor.getAttribute('aria-label'));
  }
  if (/(?:password|passwd|pwd|passcode|one[-_ ]?time|\botp\b|(?:^|[\s_-])pin(?:$|[\s_-])|cc[-_ ]|credit|debit|card[-_ ]?(?:number|no|holder|security|verification|exp)|cvv|cvc|security[-_ ]?code|verification[-_ ]?code|expir(?:y|ation)|iban|bank[-_ ]?account|routing[-_ ]?number|ssn|social[-_ ]?security|api[-_ ]?key|access[-_ ]?token|secret|numeric|decimal|パスワード|暗証|認証コード|クレジット|カード番号|口座|парол|карт[аы]|пин)/iu.test(metadata.join(' '))
    || element.matches('[data-sensitive], [data-private]')
    || element instanceof HTMLInputElement && !['text', 'search'].includes(element.type)) {
    return failure('パスワード・決済情報などの入力欄は置換しません。');
  }
  const style = getComputedStyle(element);
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') || style.display === 'none'
    || style.visibility === 'hidden' || style.visibility === 'collapse' || !element.getClientRects().length) {
    return failure('入力欄が非表示になりました。もう一度取得してください。');
  }

  const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
  const currentValue = (): string => field ? field.value : element.textContent ?? '';
  const currentSelection = (): [number | null, number | null] => {
    if (field) return [field.selectionStart, field.selectionEnd];
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1) return [null, null];
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return [null, null];
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return [start, start + range.toString().length];
  };
  if (field) {
    if (field.disabled || field.readOnly || field.matches(':disabled')) return failure('この入力欄は編集できません。');
  } else if (state.kind !== 'editable' || !['true', 'plaintext-only', ''].includes(element.getAttribute('contenteditable') ?? 'false')
    || element.getAttribute('aria-readonly') === 'true'
    || element.closest('.ProseMirror, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, [data-slate-editor], [data-lexical-editor]')
    || Array.from(element.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE)) {
    return failure('このエディタは置換に対応していません。訳文をコピーしてください。');
  }
  let selection = currentSelection();
  if (currentValue() !== state.fullText || selection[0] !== state.selectionStart || selection[1] !== state.selectionEnd) {
    return failure('原文または選択範囲が変わりました。もう一度取得してください。');
  }

  // Let the host reject editing before any mutation. No keyboard, change, or
  // submit event is generated by this operation.
  if (!element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: replacement,
  }))) return failure('ページが置換を許可しませんでした。訳文をコピーしてください。');
  selection = currentSelection();
  if (currentValue() !== state.fullText || selection[0] !== state.selectionStart || selection[1] !== state.selectionEnd
    || !element.isConnected || document.activeElement !== element || state.href !== location.href
    || (field && (field.disabled || field.readOnly || field.matches(':disabled')))
    || (!field && (!['true', 'plaintext-only', ''].includes(element.getAttribute('contenteditable') ?? 'false')
      || element.getAttribute('aria-readonly') === 'true'
      || Array.from(element.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE)))) {
    return failure('置換前に入力欄が変更されました。もう一度取得してください。');
  }

  const newValue = state.fullText.slice(0, state.start) + replacement + state.fullText.slice(state.end);
  const setValue = (value: string): void => {
    if (field) {
      const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('native-setter-unavailable');
      setter.call(field, value);
    } else element.textContent = value;
  };
  try {
    setValue(newValue);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertReplacementText', data: replacement,
    }));
    if (currentValue() !== newValue) {
      setValue(state.fullText);
      delete context.__localTranslatorCapture;
      return failure('ページ側の編集処理と競合したため原文を復元しました。訳文をコピーしてください。');
    }
    const caret = state.start + replacement.length;
    if (field) field.setSelectionRange(caret, caret);
    else {
      const range = document.createRange();
      range.setStart(element.firstChild ?? element, element.firstChild ? caret : 0);
      range.collapse(true);
      const nextSelection = window.getSelection();
      nextSelection?.removeAllRanges();
      nextSelection?.addRange(range);
    }
    delete context.__localTranslatorCapture;
    return { ok: true };
  } catch {
    try { setValue(state.fullText); } catch { /* Native host element may have been removed. */ }
    delete context.__localTranslatorCapture;
    return failure('入力欄を置換できませんでした。原文を確認し、訳文をコピーしてください。');
  }
}
