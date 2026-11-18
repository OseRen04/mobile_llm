import { TranslatorError, type Lang, type TranslateRequest } from './types';

export const LANGUAGES: readonly Lang[] = ['ja', 'en', 'ru'];
export const LANGUAGE_LABELS: Record<Lang, string> = {
  ja: '日本語',
  en: 'English',
  ru: 'Русский',
};
export const MAX_INPUT_CHARACTERS = 2_000;
export const MAX_INPUT_TOKENS = 192;

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && LANGUAGES.includes(value as Lang);
}

export function hasTranslatableText(text: string): boolean {
  // Whitespace and control-only input must not reach a model. This does not
  // rewrite accepted text or store any of it.
  return text.replace(/[\s\p{Cc}\p{Cf}]/gu, '').length > 0;
}

export function validateRequest(request: TranslateRequest): void {
  if (!isLang(request.source) || !isLang(request.target)) {
    throw new TranslatorError('unsupported-language', '日本語・英語・ロシア語を選択してください。');
  }
  if (request.source === request.target) {
    throw new TranslatorError('same-language', '翻訳元と翻訳先には異なる言語を選択してください。');
  }
  if (typeof request.text !== 'string' || !hasTranslatableText(request.text)) {
    throw new TranslatorError('empty-input', '翻訳する文章を入力してください。');
  }
  if (Array.from(request.text).length > MAX_INPUT_CHARACTERS) {
    throw new TranslatorError('input-too-long', '文章は2,000文字以内に分けて入力してください。');
  }
  if (typeof request.requestId !== 'string' || !request.requestId) {
    throw new TranslatorError('invalid-request', '処理番号がありません。もう一度実行してください。');
  }
}
