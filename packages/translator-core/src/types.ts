export type Lang = 'ja' | 'en' | 'ru';
export type ModelKey = 'toEnglish' | 'fromEnglish';

export interface TranslateRequest {
  requestId: string;
  source: Lang;
  target: Lang;
  text: string;
}

export interface TranslateResult {
  requestId: string;
  source: Lang;
  target: Lang;
  output: string;
  intermediateEnglish?: string;
  steps: 1 | 2;
  elapsedMs: number;
}

export interface Progress {
  requestId: string;
  phase: 'download' | 'load' | 'infer';
  loaded?: number;
  total?: number;
  step?: number;
  steps?: number;
  chunk?: number;
  chunks?: number;
  message?: string;
}

export type WorkerRequest =
  | { type: 'LOAD_MODEL'; requestId: string; model: ModelKey }
  | { type: 'TRANSLATE'; request: TranslateRequest }
  | { type: 'RELEASE_MODEL'; model: ModelKey }
  | { type: 'CANCEL'; requestId: string };

export type WorkerResponse =
  | ({ type: 'PROGRESS' } & Progress)
  | { type: 'RESULT'; result: TranslateResult }
  | { type: 'READY'; requestId: string; model: ModelKey }
  | { type: 'ERROR'; requestId: string; code: string; message: string };

export class TranslatorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslatorError';
  }
}
