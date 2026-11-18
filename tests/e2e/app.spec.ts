import { test, expect } from '@playwright/test';

test('validates input, confirms downloads, and stores language settings without text', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4174')) external.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '翻訳する', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('文章を入力');
  await page.getByLabel('原文', { exact: true }).fill('Private text: それは端末に残ります。');
  await page.getByLabel('翻訳先', { exact: true }).selectOption('ru');
  await expect(page.getByText('英語経由 · 2段階')).toBeVisible();
  await page.getByRole('button', { name: '翻訳する', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('236.6 MB');
  await expect(page.getByRole('dialog')).toContainText('huggingface.co');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).toContain('ru');
  expect(stored).not.toContain('Private text');
  expect(external).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('原文', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('翻訳先', { exact: true })).toHaveValue('ru');
});

test('preserves both texts during swap, supports manual result and clipboard fallback', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('原文', { exact: true }).fill('原文');
  await page.getByLabel('訳文', { exact: true }).fill('Translation');
  await page.getByRole('button', { name: '言語と原文・訳文を入れ替える' }).click();
  await expect(page.getByLabel('原文', { exact: true })).toHaveValue('Translation');
  await expect(page.getByLabel('訳文', { exact: true })).toHaveValue('原文');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.getByRole('button', { name: 'コピー', exact: true }).click();
  await expect(page.getByText('自動コピーを利用できません。', { exact: false })).toBeVisible();
  expect(await page.getByLabel('訳文', { exact: true }).evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)).toBe(2);
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(page.getByLabel('原文', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('訳文', { exact: true })).toHaveValue('');
});

test('app shell reopens offline and missing models give an actionable error', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByLabel('原文', { exact: true }).fill('こんにちは。');
  await page.getByRole('button', { name: '翻訳する', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('オンライン');
  await expect(page.getByLabel('原文', { exact: true })).toHaveValue('こんにちは。');
});

test('320px layout remains usable and rejects over-limit input before download', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByLabel('原文', { exact: true }).fill('あ'.repeat(2001));
  await page.getByRole('button', { name: '翻訳する', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('入力は2,000文字までです。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'モデル管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '翻訳モデル', exact: true })).toBeVisible();
});
