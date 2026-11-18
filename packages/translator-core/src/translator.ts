import { hasTranslatableText, MAX_INPUT_TOKENS, validateRequest } from './languages';
import { getRoute, withTargetToken } from './routing';
import { segmentText, type TextSegment } from './segmentation';
import { TranslatorError, type Lang, type ModelKey, type Progress, type TranslateRequest, type TranslateResult } from './types';

export interface InferenceOutput {
  text: string;
  /** Set when generation reached its limit without EOS. Partial output is not a success. */
  truncated?: boolean;
}

export interface TranslationBackend {
  load(model: ModelKey): Promise<void>;
  countTokens(model: ModelKey, text: string): Promise<number>;
  run(model: ModelKey, text: string): Promise<string | InferenceOutput>;
  release(model: ModelKey): Promise<void>;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new TranslatorError('cancelled', '翻訳を中断しました。');
    error.name = 'AbortError';
    throw error;
  }
}

function joinTranslated(segments: TextSegment[], target: Lang): string {
  return segments.map((segment, index) => {
    const needsWordSpace = !segment.separator && index < segments.length - 1
      && target !== 'ja' && segment.text && segments[index + 1]!.text;
    return segment.text + (needsWordSpace ? ' ' : segment.separator);
  }).join('');
}

export async function translate(
  request: TranslateRequest,
  backend: TranslationBackend,
  onProgress?: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  validateRequest(request);
  checkCancelled(signal);
  const started = performance.now();
  const route = getRoute(request.source, request.target);
  const steps = route.length as 1 | 2;
  let segments: TextSegment[] = [{ text: request.text, separator: '' }];
  let intermediateEnglish: string | undefined;

  for (let stage = 0; stage < route.length; stage++) {
    const model = route[stage]!;
    const target = model === 'toEnglish' ? 'en' : request.target;
    const prepare = (text: string): string => model === 'fromEnglish' ? withTargetToken(target, text) : text;
    const report = (phase: Progress['phase'], detail: Partial<Progress> = {}): void => {
      onProgress?.({ requestId: request.requestId, phase, step: stage + 1, steps, ...detail });
    };
    checkCancelled(signal);
    report('load');
    await backend.load(model);
    checkCancelled(signal);

    const chunks: TextSegment[] = [];
    for (const segment of segments) {
      checkCancelled(signal);
      if (!hasTranslatableText(segment.text)) {
        chunks.push(segment);
        continue;
      }
      const split = await segmentText(segment.text, async (text) => {
        checkCancelled(signal);
        const count = await backend.countTokens(model, prepare(text));
        checkCancelled(signal);
        return count;
      }, MAX_INPUT_TOKENS);
      if (split.length) split[split.length - 1]!.separator += segment.separator;
      chunks.push(...split);
    }

    const outputs: TextSegment[] = [];
    const activeChunks = chunks.filter((segment) => hasTranslatableText(segment.text)).length;
    let completed = 0;
    for (const chunk of chunks) {
      checkCancelled(signal);
      if (!hasTranslatableText(chunk.text)) {
        outputs.push(chunk);
        continue;
      }
      report('infer', { chunk: completed + 1, chunks: activeChunks });
      const response = await backend.run(model, prepare(chunk.text));
      checkCancelled(signal);
      const output = typeof response === 'string' ? response : response.text;
      if (typeof response !== 'string' && response.truncated) {
        throw new TranslatorError('output-truncated', '訳文が生成上限に達しました。原文を短くして再試行してください。');
      }
      if (typeof output !== 'string' || !hasTranslatableText(output)) {
        throw new TranslatorError('empty-output', 'モデルが訳文を返しませんでした。原文を短くして再試行してください。');
      }
      outputs.push({ text: output.trim(), separator: chunk.separator });
      completed++;
      report('infer', { chunk: completed, chunks: activeChunks, loaded: completed, total: activeChunks });
    }
    segments = outputs;
    if (stage === 0 && steps === 2) {
      intermediateEnglish = joinTranslated(outputs, 'en');
      // Only one pipeline is kept resident, including on low-memory phones.
      await backend.release(model);
      checkCancelled(signal);
    }
  }

  checkCancelled(signal);
  return {
    requestId: request.requestId,
    source: request.source,
    target: request.target,
    output: joinTranslated(segments, request.target),
    ...(intermediateEnglish === undefined ? {} : { intermediateEnglish }),
    steps,
    elapsedMs: performance.now() - started,
  };
}
