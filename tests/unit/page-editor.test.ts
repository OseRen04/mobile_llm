// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { capturePageText, replacePageText } from '../../apps/extension/src/page-editor';

let serial = 0;
beforeEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  window.getSelection()?.removeAllRanges();
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal('crypto', { randomUUID: () => `token-${++serial}` });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function input(attributes = '', value = 'Hello world'): HTMLInputElement {
  document.body.innerHTML = `<form><input ${attributes}></form>`;
  const field = document.querySelector('input')!;
  field.value = value;
  field.focus();
  return field;
}

function selectText(element: HTMLElement, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(element.firstChild!, start);
  range.setEnd(element.firstChild!, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('Chrome page editor capture and replacement', () => {
  it('captures selected text and only replaces that selection after explicit approval', () => {
    const field = input();
    field.setSelectionRange(6, 11);
    const capture = capturePageText();
    expect(capture).toMatchObject({ ok: true, text: 'world' });
    expect(capture.token).toBeTruthy();
    expect(field.value).toBe('Hello world');
    expect(replacePageText(capture.token!, capture.text!, 'мир')).toEqual({ ok: true });
    expect(field.value).toBe('Hello мир');
    expect(field.selectionStart).toBe(9);
  });

  it('captures and replaces the entire textarea when the selection is collapsed', () => {
    document.body.innerHTML = '<textarea>First\nSecond</textarea>';
    const field = document.querySelector('textarea')!;
    field.focus();
    field.setSelectionRange(2, 2);
    const capture = capturePageText();
    expect(capture.text).toBe('First\nSecond');
    expect(replacePageText(capture.token!, capture.text!, '一行目\n二行目').ok).toBe(true);
    expect(field.value).toBe('一行目\n二行目');
  });

  it('uses a native setter, emits input, and does not dispatch change or submit', () => {
    const field = input();
    const ownSetter = vi.fn();
    const get = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!;
    Object.defineProperty(field, 'value', { configurable: true, get() { return get.call(this); }, set: ownSetter });
    const onInput = vi.fn();
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    field.addEventListener('input', onInput);
    field.addEventListener('change', onChange);
    field.form!.addEventListener('submit', onSubmit);
    const capture = capturePageText();
    expect(replacePageText(capture.token!, capture.text!, 'こんにちは').ok).toBe(true);
    expect(field.value).toBe('こんにちは');
    expect(ownSetter).not.toHaveBeenCalled();
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    'type="password"', 'autocomplete="cc-number"', 'name="credit_card"',
    'autocomplete="one-time-code"', 'aria-label="暗証番号"', 'inputmode="numeric"',
    'type="email"', 'type="tel"',
  ])('does not capture sensitive/unsupported input %s', (attributes) => {
    const field = input(attributes);
    const capture = capturePageText();
    expect(capture.ok).toBe(false);
    expect(capture.text).toBeUndefined();
    expect(capture.token).toBeUndefined();
    expect(field.value).toBe('Hello world');
  });

  it('excludes payment fields identified by their visible label', () => {
    document.body.innerHTML = '<label for="field">Card number</label><input id="field">';
    const field = document.querySelector('input')!;
    field.value = '1234';
    field.focus();
    expect(capturePageText().ok).toBe(false);
  });

  it.each(['readonly', 'disabled', 'hidden', 'style="display:none"'])('does not issue a token for %s fields', (attribute) => {
    input(attribute);
    expect(capturePageText().token).toBeUndefined();
  });

  it('rejects stale text, preserving the newer page value', () => {
    const field = input();
    const capture = capturePageText();
    field.value = 'The user edited this';
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('The user edited this');
  });

  it('rejects a changed selection even when the full value is unchanged', () => {
    const field = input();
    field.setSelectionRange(0, 5);
    const capture = capturePageText();
    field.setSelectionRange(6, 11);
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('rejects detached elements, navigation, and a different active field', () => {
    const field = input();
    let capture = capturePageText();
    field.remove();
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    document.querySelector('form')!.append(field);
    field.focus();
    capture = capturePageText();
    window.history.replaceState({}, '', '/another-page');
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    capture = capturePageText();
    const other = document.createElement('textarea');
    document.body.append(other);
    other.focus();
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('rechecks field sensitivity and editability at replacement time', () => {
    const field = input();
    const capture = capturePageText();
    field.autocomplete = 'cc-number';
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    field.autocomplete = '';
    field.readOnly = true;
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('lets beforeinput veto the edit without mutating the original', () => {
    const field = input();
    const capture = capturePageText();
    field.addEventListener('beforeinput', (event) => event.preventDefault());
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('rechecks stale values after a beforeinput handler changes the page', () => {
    const field = input();
    const capture = capturePageText();
    field.addEventListener('beforeinput', () => { field.value = 'Changed by page'; });
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Changed by page');
  });

  it('does not mutate a field made readonly by a beforeinput handler', () => {
    const field = input();
    const capture = capturePageText();
    field.addEventListener('beforeinput', () => { field.readOnly = true; });
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('restores the original if a synchronous host input handler conflicts', () => {
    const field = input();
    const capture = capturePageText();
    field.addEventListener('input', () => { field.value = 'Unexpected host rewrite'; });
    expect(replacePageText(capture.token!, capture.text!, '訳文').ok).toBe(false);
    expect(field.value).toBe('Hello world');
  });

  it('consumes successful tokens and invalidates an earlier capture', () => {
    input();
    const first = capturePageText();
    const second = capturePageText();
    expect(replacePageText(first.token!, first.text!, '訳文').ok).toBe(false);
    expect(replacePageText(second.token!, second.text!, '訳文').ok).toBe(true);
    expect(replacePageText(second.token!, second.text!, '別の訳文').ok).toBe(false);
  });

  it('supports simple text-only contenteditable selections', () => {
    document.body.innerHTML = '<div contenteditable="true" tabindex="0">Hello world</div>';
    const field = document.querySelector('div')!;
    field.focus();
    selectText(field, 6, 11);
    const capture = capturePageText();
    expect(capture).toMatchObject({ ok: true, text: 'world' });
    expect(replacePageText(capture.token!, capture.text!, 'мир')).toEqual({ ok: true });
    expect(field.textContent).toBe('Hello мир');
  });

  it('returns only selected copyable text for unsupported rich editors', () => {
    document.body.innerHTML = '<div class="ProseMirror" contenteditable="true" tabindex="0">Hello world</div>';
    const field = document.querySelector('div')!;
    field.focus();
    selectText(field, 6, 11);
    expect(capturePageText()).toMatchObject({ ok: true, text: 'world' });
    expect(capturePageText().token).toBeUndefined();
    expect(field.textContent).toBe('Hello world');
  });

  it('works after function serialization without module closures', () => {
    const field = input();
    const isolatedCapture = new Function(`return (${capturePageText.toString()})`)() as typeof capturePageText;
    const isolatedReplace = new Function(`return (${replacePageText.toString()})`)() as typeof replacePageText;
    const capture = isolatedCapture();
    expect(isolatedReplace(capture.token!, capture.text!, 'こんにちは')).toEqual({ ok: true });
    expect(field.value).toBe('こんにちは');
  });
});
