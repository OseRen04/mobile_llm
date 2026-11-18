import { test, expect } from '@playwright/test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { release, totalmem } from 'node:os';
import type { InferenceClient } from '../../apps/web/src/inference-client';
import type { ModelKey, TranslateResult } from '../../packages/translator-core/src';
import type { ModelManifestEntry } from '../../packages/model-manager/src/manifest';
import type { ModelStatus } from '../../packages/model-manager/src';
import { LANGUAGE_DIRECTIONS, TRANSLATION_FIXTURES, hasExpectedScript } from '../translations/fixtures';

const manifest = JSON.parse(readFileSync(new URL('../../packages/model-manager/src/model-manifest.json', import.meta.url), 'utf8')) as Record<ModelKey, ModelManifestEntry>;

interface ModelTestHarness {
  manifest: Record<ModelKey, ModelManifestEntry>;
  assetUrl: (key: ModelKey, filename: string) => string;
  cacheName: string;
  installModel: (key: ModelKey, onProgress: (loaded: number, total: number) => void) => Promise<void>;
  getModelStatuses: () => Promise<ModelStatus[]>;
  deleteModel: (key: ModelKey) => Promise<void>;
  client: InferenceClient;
}

interface ModelReport {
  id: string;
  category: string;
  source: string;
  target: string;
  input: string;
  output?: string;
  intermediateEnglish?: string;
  steps?: number;
  elapsedMs: number;
  scriptMatches?: boolean;
  keywordsMatched?: boolean[];
  unchanged?: boolean;
  error?: string;
}

test('actual q8 Worker: verified install, 60 offline translations, privacy, restart, deletion and reinstall', async ({ page, context }, testInfo) => {
  // Run `python3 scripts/verify-models.py` to obtain the pinned real assets first.
  const assetPaths = new Map<string, string>();
  for (const model of Object.values(manifest)) {
    for (const file of model.files) {
      const local = path.resolve('.model-audit', model.id, model.revision, file.path);
      await access(local).catch(() => { throw new Error(`Missing ${local}. Run npm run verify:models first.`); });
      assetPaths.set(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`, local);
    }
  }

  const records: ModelReport[] = [];
  const browserErrors: string[] = [];
  const externalRequests: { url: string; method: string; body: string | null; phase: string }[] = [];
  const browserConsole: string[] = [];
  let initialLoadAndInferenceMs: number | undefined;
  let phase = 'install';
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') browserConsole.push(`${message.type()}: ${message.text()}`);
  });
  context.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('blob:')) {
      externalRequests.push({ url: request.url(), method: request.method(), body: request.postData(), phase });
    }
  });

  const servePinnedAsset = async (route: import('@playwright/test').Route) => {
    const filename = assetPaths.get(route.request().url());
    if (!filename) return route.abort('blockedbyclient');
    await route.fulfill({
      status: 200,
      contentType: filename.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: await readFile(filename),
    });
  };
  await context.route('https://huggingface.co/**', servePinnedAsset);

  try {
    console.log('Models: opening dedicated browser harness');
    await page.goto('/model-test.html');
    await page.waitForFunction(() => Boolean((globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest), undefined, { timeout: 30_000 });
    await test.step('verify and install real pinned assets', () => page.evaluate(async () => {
      if (!navigator.serviceWorker) throw new Error('Service Worker is unavailable');
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
      const harness = (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest;
      for (const key of Object.keys(harness.manifest) as ModelKey[]) await harness.installModel(key, () => undefined);
      if (!(await harness.getModelStatuses()).every(model => model.installed)) throw new Error('Verified model installation did not complete');
    }), { timeout: 120_000 });
    console.log('Models: both models installed and SHA-256 verified');

    // Warm the bundled WASM runtime and then discard the loaded Worker. The
    // offline checks must reload actual weights into a fresh Worker.
    phase = 'warm';
    const warm = await test.step('load actual q8 runtime and perform first inference', () => page.evaluate(() =>
      (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest.client.translate('ja', 'en', 'こんにちは。')), { timeout: 60_000 });
    initialLoadAndInferenceMs = warm.elapsedMs;
    expect(warm.output.trim()).not.toBe('');
    console.log(`Models: first real inference completed (${warm.elapsedMs.toFixed(1)} ms)`);
    await page.evaluate(() => (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest.client.cancel());
    await context.unroute('https://huggingface.co/**', servePinnedAsset);
    await context.setOffline(true);
    phase = 'offline-inference';

    for (const fixture of TRANSLATION_FIXTURES) {
      const started = Date.now();
      try {
        const result = await test.step(`offline ${fixture.id}`, () => page.evaluate(({ source, target, text }) =>
          (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest.client.translate(source, target, text), fixture), { timeout: 45_000 }) as TranslateResult;
        const output = result.output.trim();
        records.push({
          id: fixture.id, category: fixture.category, source: fixture.source, target: fixture.target,
          input: fixture.text, output: result.output, intermediateEnglish: result.intermediateEnglish,
          steps: result.steps, elapsedMs: result.elapsedMs,
          scriptMatches: hasExpectedScript(output, fixture.expectedLanguage),
          keywordsMatched: fixture.expectedKeywords.map(alternatives => alternatives.some(keyword => output.toLocaleLowerCase().includes(keyword))),
          unchanged: output === fixture.text.trim(),
        });
      } catch (error) {
        records.push({ id: fixture.id, category: fixture.category, source: fixture.source, target: fixture.target,
          input: fixture.text, elapsedMs: Date.now() - started, error: String(error) });
        // A failed pipeline may have released its model; a new request must
        // exercise the real retry path and must not reuse partial output.
        await page.evaluate(() => (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest.client.cancel());
      }
      if (records.length % 10 === 0) console.log(`Models: ${records.length}/60 offline cases completed`);
    }

    // Load and start the PWA itself from the already populated app-shell cache.
    phase = 'offline-restart';
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '翻訳を、もっと身近に。' })).toBeVisible();
    console.log('Models: offline app-shell navigation passed');
    // Return online only for the test harness document (it is deliberately
    // excluded from production app-shell assets), then perform inference offline.
    await context.setOffline(false);
    await page.goto('/model-test.html');
    await page.waitForFunction(() => Boolean((globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest), undefined, { timeout: 30_000 });
    await context.setOffline(true);
    const restarted = await test.step('offline inference after document and Worker restart', () => page.evaluate(() =>
      (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest.client.translate('en', 'ru', 'Good morning.')), { timeout: 60_000 });
    expect(restarted.output.trim()).not.toBe('');
    expect(hasExpectedScript(restarted.output, 'ru')).toBe(true);

    phase = 'delete-reinstall';
    await context.setOffline(false);
    await context.route('https://huggingface.co/**', servePinnedAsset);
    await test.step('delete, reject inference without assets, then reinstall', () => page.evaluate(async () => {
      const harness = (globalThis as unknown as { __translatorTest: ModelTestHarness }).__translatorTest;
      harness.client.cancel();
      await harness.deleteModel('fromEnglish');
      if ((await harness.getModelStatuses()).find(model => model.key === 'fromEnglish')?.installed) throw new Error('Deleted model still reports installed');
      let rejected = false;
      try { await harness.client.translate('en', 'ru', 'Please bring water.'); } catch { rejected = true; }
      if (!rejected) throw new Error('Inference succeeded without required assets');
      await harness.installModel('fromEnglish', () => undefined);
      if (!(await harness.getModelStatuses()).find(model => model.key === 'fromEnglish')?.installed) throw new Error('Reinstallation failed');
    }), { timeout: 120_000 });

    expect(records).toHaveLength(60);
    for (const [source, target] of LANGUAGE_DIRECTIONS) {
      const pair = records.filter(record => record.source === source && record.target === target);
      expect(pair, `${source} → ${target} fixture count`).toHaveLength(10);
    }
    expect(records.filter(record => record.error), 'all real model requests must finish').toEqual([]);
    expect(records.filter(record => !record.output?.trim()), 'empty generated output').toEqual([]);
    expect(records.filter(record => record.scriptMatches === false), 'target script mismatch; inspect report for language errors').toEqual([]);
    expect(externalRequests.filter(request => ['warm', 'offline-inference', 'offline-restart'].includes(request.phase)), 'inference must make zero external requests').toEqual([]);
    expect(externalRequests.filter(request => request.body || request.method !== 'GET'), 'model downloads must not send request bodies').toEqual([]);
    expect(externalRequests.filter(request => !assetPaths.has(request.url)), 'only manifest assets may be requested externally').toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    const reportPath = testInfo.outputPath('model-report.json');
    await writeFile(reportPath, JSON.stringify({
      note: 'Real q8 browser inference. Script and keyword checks are diagnostics; semantic quality requires human review. This desktop test does not establish iPhone or Android compatibility.',
      browser: await context.browser()?.version(),
      platform: `${process.platform} ${release()} (${process.arch})`,
      totalSystemMemoryBytes: totalmem(),
      initialLoadAndInferenceMs,
      models: Object.fromEntries(Object.entries(manifest).map(([key, entry]) => [key, { id: entry.id, revision: entry.revision, totalBytes: entry.totalBytes }])),
      records, externalRequests, browserErrors, browserConsole,
    }, null, 2));
    await testInfo.attach('real-model-report', { path: reportPath, contentType: 'application/json' });
  }
});
