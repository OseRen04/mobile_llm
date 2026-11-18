import { hasTranslatableText, MAX_INPUT_TOKENS } from './languages';
import { TranslatorError } from './types';

export interface TextSegment {
  text: string;
  /** Exact original whitespace following this chunk, including paragraph breaks. */
  separator: string;
}

export type TokenCounter = (text: string) => number | Promise<number>;

/** Every returned text fits the real tokenizer budget; joining text+separator is lossless. */
export async function segmentText(
  text: string,
  countTokens: TokenCounter,
  maxTokens = MAX_INPUT_TOKENS,
): Promise<TextSegment[]> {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new TranslatorError('token-limit', '入力トークン上限が不正です。');
  }
  if (!text) return [];
  const segments: TextSegment[] = [];
  const counts = new Map<string, number>();
  const fits = async (value: string): Promise<boolean> => {
    let count = counts.get(value);
    if (count === undefined) {
      count = await countTokens(value);
      if (!Number.isFinite(count) || count < 0) {
        throw new TranslatorError('tokenizer-error', '入力の長さを測定できませんでした。');
      }
      counts.set(value, count);
    }
    return count <= maxTokens;
  };

  const splitParagraph = async (paragraph: string, newline: string): Promise<void> => {
    if (!hasTranslatableText(paragraph)) {
      const separator = paragraph + newline;
      if (segments.length) segments[segments.length - 1]!.separator += separator;
      else if (separator) segments.push({ text: '', separator });
      return;
    }

    let remaining = paragraph;
    while (remaining) {
      if (!hasTranslatableText(remaining)) {
        if (segments.length) segments[segments.length - 1]!.separator += remaining;
        else segments.push({ text: '', separator: remaining });
        break;
      }
      let cut = remaining.length;
      if (!(await fits(remaining))) {
        const codepoints = Array.from(remaining);
        let low = 1;
        let high = codepoints.length;
        let fitted = 0;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = codepoints.slice(0, mid).join('');
          if (await fits(candidate)) {
            fitted = mid;
            low = mid + 1;
          } else high = mid - 1;
        }
        if (!fitted) {
          // Token counts are not strictly monotonic (subword merges). A fitted
          // prefix is sufficient; never assume truncation in the tokenizer.
          if (!(await fits(codepoints[0]!))) {
            throw new TranslatorError('token-limit', '特殊トークンを含む入力を安全に分割できません。');
          }
          fitted = 1;
        }
        const prefix = codepoints.slice(0, fitted).join('');
        cut = prefix.length;
        const boundaries = [...prefix.matchAll(/[.!?。！？]+["'»”’）)\]]*\s*/gu)];
        const sentence = boundaries[boundaries.length - 1];
        const spaces = [...prefix.matchAll(/\s+/gu)];
        const space = spaces[spaces.length - 1];
        const preferred = sentence
          ? sentence.index! + sentence[0].length
          : space && space.index! > 0 ? space.index! + space[0].length : cut;
        // Boundary preference can change BPE merges, so check it independently.
        if (preferred > 0 && await fits(remaining.slice(0, preferred))) cut = preferred;
      }
      const original = remaining.slice(0, cut);
      const trailing = original.match(/\s+$/u)?.[0] ?? '';
      const chunk = trailing ? original.slice(0, -trailing.length) : original;
      // Removing whitespace can also change tokenization. Keep it in the model
      // input if the independently measured trimmed form exceeds the budget.
      if (chunk && await fits(chunk)) segments.push({ text: chunk, separator: trailing });
      else segments.push({ text: original, separator: '' });
      remaining = remaining.slice(cut);
    }
    if (segments.length) segments[segments.length - 1]!.separator += newline;
  };

  let start = 0;
  for (const match of text.matchAll(/(?:\r\n|\r|\n)+/gu)) {
    await splitParagraph(text.slice(start, match.index), match[0]);
    start = match.index! + match[0].length;
  }
  if (start < text.length) await splitParagraph(text.slice(start), '');
  return segments;
}
