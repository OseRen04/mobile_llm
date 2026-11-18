import { describe, expect, it, vi } from 'vitest';
import {
  getRoute, segmentText, translate, validateRequest, withTargetToken,
  type Lang, type ModelKey, type TranslateRequest, type TranslationBackend,
} from '../../packages/translator-core/src';

const request = (extra: Partial<TranslateRequest> = {}): TranslateRequest => ({
  requestId: 'test-1', source: 'ja', target: 'en', text: 'こんにちは。', ...extra,
});
const characters = (text: string): number => Array.from(text).length;
const reconstruct = (segments: { text: string; separator: string }[]): string =>
  segments.map((part) => part.text + part.separator).join('');

function backend(overrides: Partial<TranslationBackend> = {}): TranslationBackend {
  return {
    load: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    countTokens: vi.fn(async (_model, text) => characters(text)),
    run: vi.fn(async (_model, text) => `translated ${text}`),
    ...overrides,
  };
}

describe('language routes and input validation', () => {
  it.each<[Lang, Lang, ModelKey[]]>([
    ['ja', 'en', ['toEnglish']], ['ru', 'en', ['toEnglish']],
    ['en', 'ja', ['fromEnglish']], ['en', 'ru', ['fromEnglish']],
    ['ja', 'ru', ['toEnglish', 'fromEnglish']], ['ru', 'ja', ['toEnglish', 'fromEnglish']],
  ])('%s → %s uses the required model stages', (source, target, models) => {
    expect(getRoute(source, target)).toEqual(models);
  });

  it('uses the tokenizer language tokens rather than ISO codes', () => {
    expect(withTargetToken('ja', 'Hello')).toBe('>>jpn<< Hello');
    expect(withTargetToken('ru', 'Hello')).toBe('>>rus<< Hello');
    expect(() => withTargetToken('en', 'Hello')).toThrow();
  });

  it.each(['', ' \t\n\r ', '\u0000\u001f\u007f', '\u200b\u200e'])('rejects blank/control-only input %j', (text) => {
    expect(() => validateRequest(request({ text }))).toThrow();
  });

  it('rejects invalid language combinations and missing IDs', () => {
    expect(() => validateRequest(request({ target: 'ja' }))).toThrow();
    expect(() => getRoute('de' as Lang, 'en')).toThrow();
    expect(() => validateRequest(request({ source: 'de' as Lang }))).toThrow();
    expect(() => validateRequest(request({ requestId: '' }))).toThrow();
  });

  it('limits Unicode code points rather than UTF-16 code units', () => {
    expect(() => validateRequest(request({ text: '😀'.repeat(2_000) }))).not.toThrow();
    expect(() => validateRequest(request({ text: '😀'.repeat(2_001) }))).toThrow();
  });
});

describe('token-measured segmentation', () => {
  it('preserves paragraphs, CRLF, blank lines, spaces, and chunk order', async () => {
    const text = '\r\n  First sentence. Second sentence!\r\n\r\n日本語です。次の文です。\n  \nlast\t';
    const split = await segmentText(text, characters, 20);
    expect(reconstruct(split)).toBe(text);
    expect(split.filter((part) => part.text)).toSatisfy((parts: { text: string }[]) =>
      parts.every((part) => characters(part.text) <= 20));
  });

  it('prefers a sentence boundary to a cut within the next sentence', async () => {
    const parts = await segmentText('First. Next sentence is long.', characters, 12);
    expect(parts[0]).toEqual({ text: 'First.', separator: ' ' });
  });

  it('splits text without word boundaries without losing surrogate pairs', async () => {
    const text = '😀日本語'.repeat(30);
    const parts = await segmentText(text, characters, 7);
    expect(reconstruct(parts)).toBe(text);
    expect(parts.every((part) => characters(part.text) <= 7)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/u.test(part.text))).toBe(true);
  });

  it('counts target prefix and tokenizer special tokens in the same budget', async () => {
    const count = (text: string): number => characters(withTargetToken('ru', text)) + 2;
    const parts = await segmentText('A very long sentence without enough budget.', count, 20);
    expect(reconstruct(parts)).toBe('A very long sentence without enough budget.');
    expect(parts.every((part) => count(part.text) <= 20)).toBe(true);
  });

  it('rejects an impossible budget instead of truncating or looping', async () => {
    await expect(segmentText('文', () => 193)).rejects.toMatchObject({ code: 'token-limit' });
    await expect(segmentText('文', () => NaN)).rejects.toMatchObject({ code: 'tokenizer-error' });
    await expect(segmentText('文', characters, 0)).rejects.toMatchObject({ code: 'token-limit' });
  });

  it('does not feed whitespace-only paragraphs to the tokenizer', async () => {
    const count = vi.fn(characters);
    const text = '\n\n  \t\r\n';
    expect(reconstruct(await segmentText(text, count))).toBe(text);
    expect(count).not.toHaveBeenCalled();
  });
});

describe('translation orchestration', () => {
  it('preserves paragraph order and emits request-scoped progress', async () => {
    const engine = backend({ run: vi.fn(async (_model, text) => text === '一' ? 'One' : 'Two') });
    const progress = vi.fn();
    const result = await translate(request({ text: '一\n\n二' }), engine, progress);
    expect(result).toMatchObject({ output: 'One\n\nTwo', steps: 1, requestId: 'test-1' });
    expect(progress.mock.calls.every(([event]) => event.requestId === 'test-1')).toBe(true);
  });

  it('resegments expanded intermediate English, adds prefix, and releases before loading stage 2', async () => {
    const events: string[] = [];
    const run = vi.fn(async (model: ModelKey, text: string) => {
      events.push(`run:${model}`);
      if (model === 'toEnglish') return 'word '.repeat(100).trim();
      expect(text.startsWith('>>rus<< ')).toBe(true);
      expect(characters(text)).toBeLessThanOrEqual(192);
      return 'перевод';
    });
    const engine = backend({
      load: vi.fn(async (model) => { events.push(`load:${model}`); }),
      release: vi.fn(async (model) => { events.push(`release:${model}`); }),
      run,
    });
    const result = await translate(request({ target: 'ru', text: '短い原文' }), engine);
    expect(result.steps).toBe(2);
    expect(result.intermediateEnglish).toBe('word '.repeat(100).trim());
    expect(run.mock.calls.filter(([model]) => model === 'fromEnglish').length).toBeGreaterThan(1);
    expect(events.indexOf('release:toEnglish')).toBeLessThan(events.indexOf('load:fromEnglish'));
    expect(result.output).toMatch(/перевод/);
  });

  it('never returns a partial success after failure in stage 2', async () => {
    const engine = backend({ run: vi.fn(async (model) => {
      if (model === 'fromEnglish') throw new Error('stage 2 failed');
      return 'English';
    }) });
    await expect(translate(request({ target: 'ru' }), engine)).rejects.toThrow('stage 2 failed');
  });

  it('rejects empty and truncated generation', async () => {
    await expect(translate(request(), backend({ run: async () => '  ' })))
      .rejects.toMatchObject({ code: 'empty-output' });
    await expect(translate(request(), backend({ run: async () => ({ text: 'Partial', truncated: true }) })))
      .rejects.toMatchObject({ code: 'output-truncated' });
  });

  it('discards a late inference response after cancellation', async () => {
    const controller = new AbortController();
    const engine = backend({ run: async () => { controller.abort(); return 'Late result'; } });
    await expect(translate(request(), engine, undefined, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled', name: 'AbortError' });
  });

  it('does not load a model for invalid or already cancelled requests', async () => {
    const engine = backend();
    await expect(translate(request({ text: '' }), engine)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(translate(request(), engine, undefined, controller.signal)).rejects.toThrow();
    expect(engine.load).not.toHaveBeenCalled();
  });
});
