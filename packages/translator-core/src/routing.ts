import { isLang } from './languages';
import { TranslatorError, type Lang, type ModelKey } from './types';

export function getRoute(source: Lang, target: Lang): ModelKey[] {
  if (!isLang(source) || !isLang(target)) {
    throw new TranslatorError('unsupported-language', '対応していない言語です。');
  }
  if (source === target) {
    throw new TranslatorError('same-language', '翻訳元と翻訳先には異なる言語を選択してください。');
  }
  if (target === 'en') return ['toEnglish'];
  if (source === 'en') return ['fromEnglish'];
  return ['toEnglish', 'fromEnglish'];
}

export function withTargetToken(target: Lang, text: string): string {
  if (target === 'ja') return `>>jpn<< ${text}`;
  if (target === 'ru') return `>>rus<< ${text}`;
  throw new TranslatorError('unsupported-target', '英語→多言語モデルの翻訳先が不正です。');
}
